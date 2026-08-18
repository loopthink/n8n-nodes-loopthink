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
}

export interface QueuedRequest {
	requestId: string;
	tool: string;
	request: HttpPayload | ParamsPayload;
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

/**
 * Two outputs, always, because a runner produces two kinds of thing: calls it
 * already handled, and calls only this workflow can answer. Fixed rather than
 * derived from configuration, so no edit anywhere can renumber them under a
 * connection that is already drawn.
 */
export const RUNNER_OUTPUTS: INodeOutputConfiguration[] = [
	// 'main' as a literal: n8n-workflow 2.x exposes NodeConnectionType as a type
	// rather than an enum value, so there is nothing to reference here.
	{ type: 'main' as INodeOutputConfiguration['type'], displayName: 'Executed' },
	{ type: 'main' as INodeOutputConfiguration['type'], displayName: 'To Answer' },
];

export const EXECUTED_OUTPUT = 0;
export const TO_ANSWER_OUTPUT = 1;

/** this.emit expects one slot per output; the unused ones stay empty. */
export function emitOn(ctx: ITriggerFunctions, index: number, item: IDataObject): void {
	const slots: ReturnType<typeof ctx.helpers.returnJsonArray>[] = RUNNER_OUTPUTS.map(() => []);
	slots[index] = ctx.helpers.returnJsonArray([item]);
	ctx.emit(slots);
}

/**
 * Hands a workflow tool to the branch that answers it.
 *
 * The masking rules travel with the item because the Result node applies them:
 * they arrive fresh with every request, which is what keeps a rule change from
 * needing a workflow edit.
 */
export function emitWorkflowTool(
	ctx: ITriggerFunctions,
	job: QueuedRequest,
	request: ParamsPayload,
): void {
	emitOn(ctx, TO_ANSWER_OUTPUT, {
		requestId: job.requestId,
		tool: job.tool,
		params: request.params ?? {},
		masking: job.masking ?? [],
		scope: job.scope ?? null,
		leaseUntil: job.leaseUntil,
	});
}
