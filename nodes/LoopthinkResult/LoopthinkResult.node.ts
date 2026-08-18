import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { applyMasking, rulesForScope, type MaskingRule } from '../LoopthinkRunner/masking';

/**
 * loopthink Result — answers a tool call the workflow handled itself.
 *
 * Masking is not a setting on this node. It is the last thing that happens
 * before the payload leaves the network, and the only way to answer a call is
 * through here, so an unmasked result is not something a workflow can send by
 * forgetting a step. The rules are never configured here either: they arrive
 * with the request, which is what lets a rule change in loopthink take effect
 * without anyone editing a workflow.
 */

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

export class LoopthinkResult implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink Result',
		name: 'loopthinkResult',
		icon: 'file:loopthink-mark.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["respondWith"]}}',
		description: 'Masks the answer and sends it back to loopthink',
		defaults: { name: 'loopthink Result' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'loopthinkRunnerApi', required: true, displayName: 'Authentication' }],
		properties: [
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
						description: 'The first input item — a single record, or an envelope built by loopthink Page',
					},
					{
						name: 'List of Objects',
						value: 'list',
						description: 'Every input item as an array',
					},
					{
						name: 'Error',
						value: 'error',
						description: 'Report a failure so the waiting caller gets a reason instead of a timeout',
					},
				],
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
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

		const respondWith = this.getNodeParameter('respondWith', 0) as 'object' | 'list' | 'error';

		let body: IDataObject;
		if (respondWith === 'error') {
			body = { error: String(this.getNodeParameter('error', 0) ?? 'Tool execution failed') };
		} else {
			const payload =
				respondWith === 'list' ? items.map((item) => item.json) : (items[0]?.json ?? {});
			body = {
				status: this.getNodeParameter('status', 0) as number,
				// The one place masking happens for a workflow tool.
				data: applyMasking(payload, rulesForScope(request.masking ?? [], request.scope ?? undefined)),
			};
		}

		const response = await this.helpers.httpRequest({
			method: 'POST',
			url: `${queueUrl}/group/${credentials.workspaceId}/${credentials.groupId}/runner/request/${requestId}/result`,
			headers: { Authorization: `Bearer ${credentials.secret}` },
			body,
			json: true,
		});

		// A duplicate is not a failure: delivery is at-least-once, and the first
		// answer is the one the waiting caller already read. Reported rather than
		// thrown so a retry does not turn a healthy workflow red.
		return [
			this.helpers.returnJsonArray([
				{
					requestId,
					status: body.status ?? null,
					error: body.error ?? null,
					accepted: (response as IDataObject)?.accepted ?? null,
					duplicate: (response as IDataObject)?.duplicate ?? null,
					maskingRules: (request.masking ?? []).length,
				},
			]),
		];
	}
}
