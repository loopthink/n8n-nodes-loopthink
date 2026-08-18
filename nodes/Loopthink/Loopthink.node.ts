import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import { executeResult, resultFields } from './result.operation';

/**
 * loopthink — what a workflow does with a claimed tool call.
 *
 * Deliberately one thing: mask the answer and send it. There was a second
 * operation that built index pages, and it turned out to be a node earning its
 * place from a limitation that was not there. Paging by cursor rather than
 * offset makes the source do the work — a `<` on a unique key with a Limit,
 * which both the Data Table node and SQL express natively — and n8n's own
 * Aggregate node bundles and trims the rows. Nothing was left for ours to do
 * that a standard node did not already do better.
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
			{ name: 'loopthinkRunnerApi', required: true, displayName: 'Authentication' },
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
				],
			},
			...resultFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return executeResult.call(this);
	}
}
