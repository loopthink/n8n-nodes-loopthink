import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { applyMasking, rulesForScope, type MaskingRule } from '../LoopthinkRunner/masking';

/**
 * Send Result — answers a tool call the workflow handled itself.
 *
 * Masking is not a setting on this node. It is the last thing that happens
 * before the payload leaves the network, and the only way to answer a call is
 * through here, so an unmasked result is not something a workflow can send by
 * forgetting a step. The rules are never configured here either: they arrive
 * with the request, which is what lets a rule change in loopthink take effect
 * without anyone editing a workflow.
 */

/**
 * The envelope a listing tool answers with.
 *
 * There is no cursor. The branch reads one row more than it answers with, and
 * that extra row is the whole mechanism: if it arrived, there was more. It costs
 * nothing, it is exact, and it needs no total, which the Data Table node does
 * not hand out anyway.
 *
 * A model told `truncated` narrows its filters, or continues past the last id it
 * saw. Both are ordinary filters it already understands, which is why no opaque
 * token travels back and forth.
 */
function pagePayload(
	ctx: IExecuteFunctions,
	respondWith: 'object' | 'list' | 'page',
	items: INodeExecutionData[],
): IDataObject | IDataObject[] {
	if (respondWith === 'object') return (items[0]?.json ?? {}) as IDataObject;

	// n8n's "Always Output Data" emits one empty item when a node found nothing,
	// which is how a listing that matched no rows arrives here as `[{}]`. Sent on,
	// that reads to a model as one record with every field missing rather than as
	// an empty result, and it will happily describe it.
	const rows = items
		.map((item) => item.json as IDataObject)
		.filter((row) => row && Object.keys(row).length > 0);
	if (respondWith === 'list') return rows as unknown as IDataObject;

	const limit = Number(ctx.getNodeParameter('pageSize', 0));
	const capped = Number.isFinite(limit) && limit > 0;

	// The extra row is evidence, not content. Sending it would answer with one
	// more than was asked for, and quietly change what `limit` means.
	return { items: capped ? rows.slice(0, limit) : rows, truncated: capped && rows.length > limit };
}

/**
 * What one answer may carry.
 *
 * Mirrors the platform's own budget, deliberately duplicated: this node runs in
 * the customer's n8n and shares no code with the backend, and the value has to
 * be known *here* to be useful. Measured after the POST, an oversized body is
 * already a rejected request, the call stays unanswered, and the caller waits
 * out its timeout to be told nothing.
 */
const MAX_RESULT_BYTES = 300 * 1024;

/**
 * The status that says "ran fine, does not fit".
 *
 * Sent alongside the sentence rather than as a bare error, because the platform
 * has to tell this apart from a tool that actually broke: one is something the
 * model resolves by asking for a narrower slice, the other is not. Without the
 * status the backend has only the wording to go on.
 */
const RESULT_TOO_LARGE_STATUS = 413;

/**
 * Written for the model, not for whoever is reading this execution.
 *
 * The size is a fact about our queue; the model that asked has no idea it caused
 * this. So the sentence says what came back, what fits, and the two ways to ask
 * for less. A model told that splits the range and asks again, which is the
 * behaviour we want and the one a status code never produces.
 */
function tooLargeMessage(bytes: number, rows?: number): string {
	const kb = (n: number) => `${Math.round(n / 1024)} KB`;
	const counted = rows === undefined ? '' : `${rows.toLocaleString('en-US')} rows, `;
	return (
		`The result was too large to return: ${counted}${kb(bytes)}, and one answer can carry ${kb(MAX_RESULT_BYTES)}. ` +
		'Nothing was returned. Ask for a smaller slice and combine the answers: narrow the filters, for instance a ' +
		'shorter date range or a more specific match, or pass a smaller limit if this tool takes one.'
	);
}

function countRows(payload: unknown): number | undefined {
	if (Array.isArray(payload)) return payload.length;
	const items = (payload as IDataObject)?.items;
	return Array.isArray(items) ? items.length : undefined;
}

interface QueuedRequestRef {
	requestId?: string;
	masking?: MaskingRule[];
	scope?: string | null;
}

function parseRequest(value: unknown): QueuedRequestRef {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as QueuedRequestRef;
		} catch {
			return {};
		}
	}
	return (value ?? {}) as QueuedRequestRef;
}

export const resultFields: INodeProperties[] = [
		{
			displayName: 'Request',
			name: 'request',
			type: 'json',
			default: "={{ $('loopthink Runner').first().json }}",
			description:
				'The queued request this answers. Leave this as it is unless you renamed the Runner node, in which case put its name in the expression.',
		},
		{
			displayName: 'Respond With',
			name: 'respondWith',
			type: 'options',
			default: 'object',
			options: [
				{
					name: 'One Object',
					value: 'object',
					description: 'The first input item: a single record, or an envelope the branch built',
				},
				{
					name: 'List of Objects',
					value: 'list',
					description: 'Every input item as an array',
				},
				{
					name: 'Capped List',
					value: 'page',
					description:
						'Up to the limit, plus a flag saying whether there was more. What a listing tool answers with.',
				},
				{
					name: 'Error',
					value: 'error',
					description: 'Report a failure so the waiting caller gets a reason instead of a timeout',
				},
			],
		},
		{
			displayName: 'Limit',
			name: 'pageSize',
			type: 'number',
			// The useful default is the limit the call was made with, which is an
			// expression; a literal would quietly disagree with it. The comment has
			// to sit directly above the property or --fix replaces the default.
			// eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-number
			default: "={{ $('loopthink Runner').first().json.params.limit }}",
			displayOptions: { show: { respondWith: ['page'] } },
			// `$json` is n8n's own variable. Upper-cased it is not a JSON reference,
			// it is a broken expression, so the rule has to be off for this line.
			// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-json
			description:
				'How many rows to answer with. Set the reading node\'s own limit to {{ $json.params.limit + 1 }}: if that extra row arrives, the answer is marked truncated.',
		},
		{
			displayName: 'Status',
			name: 'status',
			type: 'number',
			default: 200,
			displayOptions: { hide: { respondWith: ['error'] } },
		},
		{
			displayName: 'Error Message',
			name: 'error',
			type: 'string',
			default: '={{ $json.error }}',
			displayOptions: { show: { respondWith: ['error'] } },
		},
		{
			displayName:
				'The masking rules configured for this tool in loopthink are applied here, inside your network, before anything is sent. They travel with each request, so changing them needs no change to this workflow.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
];

export async function executeResult(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const credentials = await this.getCredentials('loopthinkRunnerApi');

	const queueUrl = String(credentials.queueUrl || '').replace(/\/+$/, '');
	const request = parseRequest(this.getNodeParameter('request', 0));
	const requestId = request.requestId;

	if (!requestId) {
		throw new NodeOperationError(
			this.getNode(),
			'No requestId in the Request parameter',
			{
				description:
					'It should point at the loopthink Runner node that claimed this call. If you renamed that node, update the expression to match.',
			},
		);
	}

	const respondWith = this.getNodeParameter('respondWith', 0) as
		| 'object'
		| 'list'
		| 'page'
		| 'error';

	let body: IDataObject;
	if (respondWith === 'error') {
		body = { error: String(this.getNodeParameter('error', 0) ?? 'Tool execution failed') };
	} else {
		const payload = pagePayload(this, respondWith, items);
		// The one place masking happens for a workflow tool.
		const data = applyMasking(payload, rulesForScope(request.masking ?? [], request.scope ?? undefined));

		// Measured on the masked copy, because that is the one that travels, and
		// after masking rather than before, because a redaction changes the size.
		const size = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
		body =
			size > MAX_RESULT_BYTES
				? { status: RESULT_TOO_LARGE_STATUS, error: tooLargeMessage(size, countRows(data)) }
				: { status: this.getNodeParameter('status', 0) as number, data };
	}

	const response = await this.helpers.httpRequest({
		method: 'POST',
		url: `${queueUrl}/group/${credentials.workspaceId}/${credentials.groupId}/runner/request/${requestId}/result`,
		headers: { Authorization: `Bearer ${credentials.secret}` },
		body,
		json: true,
	});

	// The masked payload is part of the output, not just the bookkeeping: this is
	// the node where you check what actually left the network, and "it was sent"
	// is a weaker answer than showing the thing that was sent.
	//
	// It costs nothing in exposure. The unmasked rows are already in this
	// execution's data on the node before this one, so the masked copy is the
	// less sensitive of the two — and it is by definition what already travelled
	// to the platform.
	//
	// A duplicate is not a failure: delivery is at-least-once, and the first
	// answer is the one the waiting caller already read. Reported rather than
	// thrown so a retry does not turn a healthy workflow red.
	return [
		this.helpers.returnJsonArray([
			{
				requestId,
				status: body.status ?? null,
				error: body.error ?? null,
				maskingRules: (request.masking ?? []).length,
				accepted: (response as IDataObject)?.accepted ?? null,
				duplicate: (response as IDataObject)?.duplicate ?? null,
				sent: body.data ?? null,
			},
		]),
	];
}
