import type { IDataObject, INodeProperties, ITriggerFunctions } from 'n8n-workflow';
import type { MaskingRule } from './masking';

/**
 * Workflow tools: the part of a runner that is the same whether work is polled
 * or pushed.
 *
 * Shared rather than copied because both transports must agree on it exactly. A
 * second implementation that differs in which output a tool lands on, or in
 * whether an unlisted tool is answered at all, would be a bug that only shows up
 * on one transport — and the two are meant to be interchangeable.
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
 * workflow is the only thing that can answer, so the request goes out an output
 * and comes back through a loopthink Result node.
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

export function toolList(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
}

/**
 * One output per workflow tool, so the branch answering a tool is labelled with
 * the tool's own name. Without any, the node keeps its single output and every
 * existing workflow stays valid.
 *
 * Interpolated into the node's `outputs` expression as source text, so it has to
 * stay self-contained: no imports, no module-scope references, nothing from a
 * closure. Calling toolList() here would compile to a reference n8n cannot
 * resolve, which is why the split is spelled out again.
 */
export const configuredOutputs = (parameters: IDataObject) => {
	const names = String(parameters.workflowTools ?? '')
		.split(',')
		.map((name: string) => name.trim())
		.filter(Boolean);
	if (names.length === 0) return [{ type: 'main', displayName: 'Executed' }];
	return [
		{ type: 'main', displayName: 'Executed' },
		...names.map((name: string) => ({ type: 'main', displayName: name })),
	];
};

export const workflowToolsProperty: INodeProperties = {
	displayName: 'Workflow Tools',
	name: 'workflowTools',
	type: 'string',
	default: '',
	placeholder: 'dt_customers_index, dt_customers_show',
	description:
		'Comma-separated names of tools this workflow answers itself, in the order you want the outputs. Each one gets an output of its own; end that branch with a loopthink Result node. Tools not listed here are executed by this node as HTTP calls.',
};

/** How many outputs the node has, given its configured tools. */
export function outputCount(tools: string[]): number {
	return tools.length === 0 ? 1 : tools.length + 1;
}

/**
 * this.emit expects one slot per output, so a branch is chosen by putting the
 * item in that slot and leaving the rest empty.
 *
 * Always full width, not just up to the slot being used: a short array looks to
 * the engine like the node has fewer outputs than it does, and a downstream
 * `$('loopthink Runner')` resolving a later branch fails with "has no branch
 * with index N" instead of finding an empty one.
 */
export function emitOn(
	ctx: ITriggerFunctions,
	total: number,
	index: number,
	item: IDataObject,
): void {
	const slots: ReturnType<typeof ctx.helpers.returnJsonArray>[] = Array.from(
		{ length: total },
		() => [],
	);
	slots[index] = ctx.helpers.returnJsonArray([item]);
	ctx.emit(slots);
}

/**
 * Hands a workflow tool to its branch, or answers it if there is none.
 *
 * The masking rules travel with the item because the Result node applies them:
 * they arrive fresh with every request, which is what keeps a rule change from
 * needing a workflow edit.
 */
export async function handOverToBranch(
	ctx: ITriggerFunctions,
	tools: string[],
	job: QueuedRequest,
	request: ParamsPayload,
	report: (requestId: string, result: IDataObject) => Promise<void>,
): Promise<void> {
	const index = tools.indexOf(job.tool);
	if (index === -1) {
		// Answer immediately rather than dropping it. The caller in the cloud is
		// blocking, and an unlisted tool would otherwise look like a hang for the
		// full 25 seconds before failing without a reason.
		await report(job.requestId, {
			status: 501,
			error: `This runner has no branch for tool "${job.tool}". Add it to Workflow Tools on the loopthink Runner node.`,
		});
		ctx.logger.warn(`loopthink Runner: no branch for tool "${job.tool}"`);
		return;
	}
	// +1: output 0 is the audit trail for tools this node executes itself.
	emitOn(ctx, outputCount(tools), index + 1, {
		requestId: job.requestId,
		tool: job.tool,
		params: request.params ?? {},
		masking: job.masking ?? [],
		scope: job.scope ?? null,
		leaseUntil: job.leaseUntil,
	});
}
