import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import { executePage, pageFields } from './page.operation';
import { executeResult, resultFields } from './result.operation';

/**
 * loopthink — what a workflow does with a claimed tool call.
 *
 * One node with two operations rather than two nodes, because they are two steps
 * of one job and always appear together: shape the answer, then send it. n8n
 * lists the operations as actions of their own, so nothing is harder to find,
 * and the node panel stops carrying four entries that are really two ideas.
 *
 * The runner itself stays separate. It is a trigger: no inputs, a lifecycle of
 * its own, and n8n cannot combine a trigger with a regular node.
 */
export class Loopthink implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink',
		name: 'loopthink',
		icon: 'file:loopthink-mark.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Shape and answer a loopthink tool call',
		defaults: { name: 'loopthink' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'loopthinkRunnerApi',
				required: true,
				displayName: 'Authentication',
				// Only sending needs it; paging is local.
				displayOptions: { show: { operation: ['result'] } },
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
						name: 'Build Index Page',
						value: 'page',
						description: 'Filter, page and trim rows into one index answer',
						action: 'Build an index page',
					},
				],
			},
			...resultFields.map((field) => ({
				...field,
				displayOptions: { ...field.displayOptions, show: { ...field.displayOptions?.show, operation: ['result'] } },
			})),
			...pageFields.map((field) => ({
				...field,
				displayOptions: { ...field.displayOptions, show: { ...field.displayOptions?.show, operation: ['page'] } },
			})),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as 'result' | 'page';
		return operation === 'page' ? executePage.call(this) : executeResult.call(this);
	}
}
