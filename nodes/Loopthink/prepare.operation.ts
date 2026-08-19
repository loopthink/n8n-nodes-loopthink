import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { prepareQuery, type MatchSpec, type RangeSpec } from './query';

/**
 * Prepare Query — the parameters a model sent, turned into values a Data Table
 * node can put in its fixed condition rows.
 *
 * It does not read the table. n8n allows only its own nodes at the data table
 * proxy, so the reading stays with the Data Table node; what this removes is
 * the arithmetic around it. Without it every condition row carries the full
 * `$('loopthink Runner').first().json.params.x || '0001-01-01T00:00:00.000Z'`,
 * and the sentinel that keeps an unused row harmless is pasted into the
 * workflow four or five times, where it is neither named nor tested.
 *
 * After it, a row reads `{{ $json.q.createdAt_min }}` and the sentinel lives
 * here, with the reason it has that value.
 */

export const prepareFields: INodeProperties[] = [
	{
		displayName: 'Parameters',
		name: 'params',
		type: 'json',
		default: '={{ $json.params }}',
		description:
			'What the model sent. Leave this as it is unless the branch reshapes the item first.',
	},
	{
		displayName: 'Rows per Answer',
		name: 'defaultLimit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 500 },
		default: 20,
		description:
			'The most rows a single answer carries. Used when the call sends no limit, and a larger limit is capped to it.',
	},
	{
		displayName: 'Order',
		name: 'order',
		type: 'options',
		default: 'DESC',
		options: [
			{ name: 'Newest First', value: 'DESC' },
			{ name: 'Oldest First', value: 'ASC' },
		],
		// `id` here is the column name n8n gives every data table, not the word;
		// upper-casing it would name something that does not exist.
		// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
		description:
			'Used unless the call sends a sort parameter of "oldest" or "newest". Ascending by id is also what lets a model read a long list in order.',
	},
	{
		displayName: 'Optional Ranges',
		name: 'ranges',
		placeholder: 'Add range',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		// `id` here is the column name n8n gives every data table, not the word;
		// upper-casing it would name something that does not exist.
		// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
		description:
			'One entry per column the tool can narrow down. Each yields a min and a max, filled from the call or opened all the way up. A range on id is what lets a model continue past the last row it saw.',
		options: [
			{
				name: 'range',
				displayName: 'Range',
				values: [
					{
						displayName: 'Column',
						name: 'column',
						type: 'string',
						default: '',
						placeholder: 'createdAt',
						description:
					'Also the stem of the two keys it appears under, as q.createdAt_min and q.createdAt_max',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						default: 'date',
						options: [
							{ name: 'Date', value: 'date' },
							{ name: 'Number', value: 'number' },
						],
					},
					{
						displayName: 'Parameter Prefix',
						name: 'parameter',
						type: 'string',
						default: '',
						placeholder: 'created',
						description:
							'Only when the parameters are not named after the column. Empty means the column name is the prefix, so a column "check_in" reads check_in_after and check_in_before.',
					},
				],
			},
		],
	},
	{
		displayName: 'Optional Exact Matches',
		name: 'matches',
		placeholder: 'Add match',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		description:
			'One entry per column the tool can pin to a value. Compare the row with "contains": an equals row has no value that means "no filter", a wildcard does.',
		options: [
			{
				name: 'match',
				displayName: 'Match',
				values: [
					{
						displayName: 'Column',
						name: 'column',
						type: 'string',
						default: '',
						placeholder: 'status',
						description: 'Also the key it appears under, as q.status',
					},
					{
						displayName: 'Parameter',
						name: 'parameter',
						type: 'string',
						default: '',
						description: 'Only when the parameter is not named after the column',
					},
				],
			},
		],
	},
	{
		displayName:
			'Each key holds one value, so a condition row is <b>column</b>, a comparison you pick once, and <code>{{ $json.q.&lt;key&gt; }}</code> in <b>Value</b>. A range yields two keys, <code>q.&lt;column&gt;_min</code> and <code>q.&lt;column&gt;_max</code>; a match yields one, <code>q.&lt;column&gt;</code>, compared with <b>contains</b>. Set <b>Limit</b> to <code>q.fetch</code> and <b>Order</b> to <code>q.order</code>. Every key holds a value on every call, so no row has to be removed for a parameter the model left out, and <code>q.unused</code> names any the tool offers that no row reads.',
		name: 'prepareNotice',
		type: 'notice',
		default: '',
	},
];

function parseParams(value: unknown): Record<string, unknown> {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return (value ?? {}) as Record<string, unknown>;
}

export async function executePrepare(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const out: INodeExecutionData[] = [];

	for (let i = 0; i < this.getInputData().length; i += 1) {
		const params = parseParams(this.getNodeParameter('params', i));
		const ranges = ((this.getNodeParameter('ranges', i, {}) as IDataObject).range ??
			[]) as unknown as RangeSpec[];
		const matches = ((this.getNodeParameter('matches', i, {}) as IDataObject).match ??
			[]) as unknown as MatchSpec[];

		const q = prepareQuery(params, {
			defaultLimit: this.getNodeParameter('defaultLimit', i) as number,
			order: this.getNodeParameter('order', i) as 'ASC' | 'DESC',
			ranges,
			matches,
		});

		// The request travels with it, so the branch downstream keeps reaching
		// requestId and masking without naming the Runner node again.
		out.push({ json: { ...this.getInputData()[i].json, q } });
	}

	return [out];
}
