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
 * One operation, and it earns its place: masking runs with the rules that
 * arrived alongside the request, and answering is the only way out, so an
 * unmasked result is not something a workflow can send by forgetting a step.
 *
 * Three others were here and are gone, each once the platform or a standard node
 * turned out to do the job. One built index pages. One filled the Data Table
 * node's condition rows, which the platform now sends as `$json.q`. And one
 * issued HTTP calls with `{{secret.NAME}}` resolved on the way out; a tool now
 * carries its path as a fixed parameter and the workflow makes the call with
 * n8n's own credentials, which never left this network to begin with.
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
				],
			},
			...resultFields.map((field) => ({
				...field,
				displayOptions: { ...field.displayOptions, show: { ...field.displayOptions?.show, operation: ['result'] } },
			})),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return executeResult.call(this);
	}
}
