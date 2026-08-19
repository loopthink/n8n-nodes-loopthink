import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import { executeRequest, executeFields } from './execute.operation';
import { executeResult, resultFields } from './result.operation';

/**
 * loopthink — what a workflow does with a claimed tool call.
 *
 * Two operations, and both earn it by doing something no standard node can.
 * Send Result masks with rules that arrived alongside the request. Execute
 * Request resolves `{{secret.NAME}}` before issuing the call, which a plain HTTP
 * Request node would forward verbatim into the target's access log.
 *
 * A third one built index pages and has been removed: it earned its place from a
 * limitation that was not there. Paging by cursor rather than offset lets the
 * source do the work, and n8n's own Aggregate node bundles and trims the rows.
 *
 * The runner stays separate. It is a trigger: no inputs, a lifecycle of its own,
 * and n8n cannot combine a trigger with a regular node.
 */
export class Loopthink implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink',
		name: 'loopthink',
		icon: 'file:loopthink-mark.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["respondWith"]}}',
		description: 'Shape and answer a loopthink tool call',
		defaults: { name: 'loopthink' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'loopthinkRunnerApi',
				required: true,
				displayName: 'Authentication',
				displayOptions: { show: { operation: ['result'] } },
			},
			{
				// Only the executing operation needs them: a workflow that answers
				// Data Table tools should not carry a credential for an API it never
				// calls.
				name: 'loopthinkTargetApi',
				required: false,
				displayName: 'Secrets',
				displayOptions: { show: { operation: ['execute'] } },
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'result',
				options: [
					{
						name: 'Send Result',
						value: 'result',
						description: 'Mask the answer and send it back to loopthink',
						action: 'Send the result back to loopthink',
					},
					{
						name: 'Execute Request',
						value: 'execute',
						description: 'Issue the HTTP call loopthink resolved, filling in your secrets',
						action: 'Execute the resolved HTTP request',
					},
				],
			},
			...resultFields.map((field) => ({
				...field,
				displayOptions: { ...field.displayOptions, show: { ...field.displayOptions?.show, operation: ['result'] } },
			})),
			...executeFields.map((field) => ({
				...field,
				displayOptions: { ...field.displayOptions, show: { ...field.displayOptions?.show, operation: ['execute'] } },
			})),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as 'result' | 'execute';
		return operation === 'execute' ? executeRequest.call(this) : executeResult.call(this);
	}
}
