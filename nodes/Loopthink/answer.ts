import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import type { MaskingRule } from '../LoopthinkRunner/masking';

/**
 * How an answer leaves the network: the budget it must fit, the sentence sent
 * instead when it does not, and the POST that carries it. Shared by every
 * operation that answers a call, so the two of them cannot disagree on what
 * fits or where it goes.
 */

/**
 * What one answer may carry.
 *
 * Mirrors the platform's own budget, deliberately duplicated: this node runs in
 * the customer's n8n and shares no code with the backend, and the value has to
 * be known *here* to be useful. Measured after the POST, an oversized body is
 * already a rejected request, the call stays unanswered, and the caller waits
 * out its timeout to be told nothing.
 *
 * 5 MB since mcp stores the answer in its result bucket rather than in the queue
 * item (which capped it at 300 KB). What bounds it now is the way back to the
 * client, a synchronous Lambda response of 6 MB, less the JSON around the data.
 */
export const MAX_RESULT_BYTES = 5 * 1024 * 1024;

/**
 * The status that says "ran fine, does not fit".
 *
 * Sent alongside the sentence rather than as a bare error, because the platform
 * has to tell this apart from a tool that actually broke: one is something the
 * model resolves by asking for a narrower slice, the other is not. Without the
 * status the backend has only the wording to go on.
 */
export const RESULT_TOO_LARGE_STATUS = 413;

/**
 * Written for the model, not for whoever is reading this execution.
 *
 * The size is a fact about our queue; the model that asked has no idea it caused
 * this. So the sentence says what came back, what fits, and the two ways to ask
 * for less. A model told that splits the range and asks again, which is the
 * behaviour we want and the one a status code never produces.
 */
export function formatBytes(n: number): string {
	if (n >= 1024 * 1024) {
		const mb = n / (1024 * 1024);
		return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
	}
	return `${Math.round(n / 1024)} KB`;
}

export function tooLargeMessage(bytes: number, rows?: number): string {
	const counted = rows === undefined ? '' : `${rows.toLocaleString('en-US')} rows, `;
	return (
		`The result was too large to return: ${counted}${formatBytes(bytes)}, and one answer can carry ${formatBytes(MAX_RESULT_BYTES)}. ` +
		'Nothing was returned. Ask for a smaller slice and combine the answers: narrow the filters, for instance a ' +
		'shorter date range or a more specific match, or pass a smaller limit if this tool takes one.'
	);
}

export function countRows(payload: unknown): number | undefined {
	if (Array.isArray(payload)) return payload.length;
	const items = (payload as IDataObject)?.items;
	return Array.isArray(items) ? items.length : undefined;
}

/** The queued request as the Runner emitted it, however the parameter holds it. */
export interface QueuedRequestRef {
	requestId?: string;
	tool?: string;
	method?: string;
	params?: IDataObject;
	masking?: MaskingRule[];
	scope?: string | null;
}

export function parseRequest(value: unknown): QueuedRequestRef {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as QueuedRequestRef;
		} catch {
			return {};
		}
	}
	return (value ?? {}) as QueuedRequestRef;
}

/**
 * The body an answer travels as: the masked data with its status, or, past the
 * budget, the sentence and the status that marks it as a notice rather than a
 * failure. Measured on the masked copy, because that is the one that travels,
 * and after masking rather than before, because a redaction changes the size.
 */
export function budgetedBody(data: unknown, status: number): IDataObject {
	const size = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
	return size > MAX_RESULT_BYTES
		? { status: RESULT_TOO_LARGE_STATUS, error: tooLargeMessage(size, countRows(data)) }
		: { status, data: data as IDataObject };
}

/** Posts an answer to the queue the call was claimed from. */
export async function postAnswer(
	ctx: IExecuteFunctions,
	requestId: string,
	body: IDataObject,
): Promise<IDataObject> {
	const credentials = await ctx.getCredentials('loopthinkRunnerApi');
	const queueUrl = String(credentials.queueUrl || '').replace(/\/+$/, '');
	const response = await ctx.helpers.httpRequest({
		method: 'POST',
		url: `${queueUrl}/group/${credentials.workspaceId}/${credentials.groupId}/runner/request/${requestId}/result`,
		headers: { Authorization: `Bearer ${credentials.secret}` },
		body,
		json: true,
	});
	return (response ?? {}) as IDataObject;
}
