import type { IDataObject, INodeOutputConfiguration, ITriggerFunctions } from 'n8n-workflow';
import type { MaskingRule } from './masking';

/**
 * Workflow tools: the part of a runner that is the same whether work is polled
 * or pushed.
 *
 * Shared rather than copied because both transports must agree on it exactly. A
 * second implementation that differed in what reaches the workflow would be a
 * bug visible on only one transport — and the two are meant to be
 * interchangeable.
 *
 * The runner does not know which tools this workflow answers, and deliberately
 * so. It had a comma-separated list once, with one output per name; the outputs
 * were then matched by position, so inserting a tool in the middle silently
 * rewired every branch after it, and a typo produced a name that simply never
 * matched. Routing by name is what a Switch node does, visibly, with the names
 * where you can read them.
 */

/** An HTTP call the platform resolved in full, credentials excluded. */
export interface HttpPayload {
	kind?: 'http';
	method: string;
	url: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
}

/**
 * A tool the runner cannot execute, and is not meant to: the platform sends the
 * validated arguments and nothing else, because the source has no address to
 * call. An n8n Data Table, a Sheet, a database, a node-only integration — the
 * workflow is the only thing that can answer, so the request leaves on the
 * second output and comes back through a loopthink Result node.
 */
export interface ParamsPayload {
	kind: 'params';
	params: IDataObject;
	/**
	 * The same parameters, shaped for a workflow whose filter rows are fixed.
	 * Every parameter the tool declares has a key here on every call: the value
	 * that was sent, or one that cannot exclude anything. A Data Table node's
	 * conditions are decided when the workflow is built and cannot be computed
	 * per call, so an unused row has to hold something harmless, and the platform
	 * is the only side that knows every parameter and its type.
	 */
	q?: IDataObject;
}

/**
 * A statement the platform bound and the workflow executes.
 *
 * It arrives as text on purpose. Which node runs it, against which credential
 * and in which dialect, is the customer's decision and lives in their workflow;
 * the platform only knows what to ask for. That is what makes a Postgres tool
 * possible without the platform ever holding the database password.
 *
 * The values are already substituted, escaped by the platform with the same
 * rules its own driver uses. `params` carries them separately as well, for a
 * branch that wants to decide something without parsing the text back apart.
 */
export interface StatementPayload {
	kind: 'statement';
	statement: string;
	params: IDataObject;
}

export interface QueuedRequest {
	requestId: string;
	tool: string;
	request: HttpPayload | ParamsPayload | StatementPayload;
	masking: MaskingRule[];
	scope?: string;
	credentialRef?: string;
	leaseUntil: number;
}

// An item queued before the payload became a union carries no discriminator,
// and an absent one has always meant http.
export function isParamsRequest(request: QueuedRequest['request']): request is ParamsPayload {
	return (request as ParamsPayload)?.kind === 'params';
}

export function isStatementRequest(
	request: QueuedRequest['request'],
): request is StatementPayload {
	return (request as StatementPayload)?.kind === 'statement';
}

/**
 * One output. The runner claims work and emits it; what to do with a call is the
 * workflow's decision, routed by tool name where the names are readable.
 *
 * It had two for a while, "Executed" and "To Answer", because the node used to
 * run HTTP tools itself and those were already answered by the time they
 * appeared. Executing moved out to the loopthink node, and the distinction went
 * with it.
 */
export const RUNNER_OUTPUTS: INodeOutputConfiguration[] = [
	// 'main' as a literal: n8n-workflow 2.x exposes NodeConnectionType as a type
	// rather than an enum value, so there is nothing to reference here.
	{ type: 'main' as INodeOutputConfiguration['type'] },
];

/**
 * Emits a claimed call for the workflow to handle.
 *
 * `request` travels as it arrived, http or params, so one branch reads
 * `$json.request.url` and another `$json.params`. The masking rules come along
 * because Send Result applies them: they arrive fresh with every request, which
 * is what keeps a rule change from needing a workflow edit.
 */
export function emitJob(ctx: ITriggerFunctions, job: QueuedRequest): void {
	ctx.emit([
		ctx.helpers.returnJsonArray([
			{
				requestId: job.requestId,
				tool: job.tool,
				request: job.request as unknown as IDataObject,
				// Flattened out of the payload so a branch reads `$json.params` and
				// `$json.statement` whatever kind of tool it answers, instead of
				// knowing where in `request` each one hides.
				params: isParamsRequest(job.request) || isStatementRequest(job.request)
					? job.request.params
					: {},
				statement: isStatementRequest(job.request) ? job.request.statement : null,
				q: isParamsRequest(job.request) ? (job.request.q ?? {}) : {},
				masking: job.masking ?? [],
				scope: job.scope ?? null,
				leaseUntil: job.leaseUntil,
			},
		]),
	]);
}
