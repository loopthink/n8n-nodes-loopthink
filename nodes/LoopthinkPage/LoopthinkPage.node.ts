import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

/**
 * loopthink Page — turns a pile of rows into one page of an index.
 *
 * Three jobs a listing tool always needs and no source reliably provides:
 *
 * 1. **Date ranges that are actually dates.** n8n's Data Table compares filter
 *    values as strings against a stored `YYYY-MM-DD HH:MM:SS.mmm`, so a filter
 *    written as `2026-08-18T00:00:00Z` sorts *after* every row from that day:
 *    the `T` outranks the space. It returns nothing and looks like an empty
 *    table. Here both sides are parsed as dates, so the answer is right
 *    whatever the source stores.
 * 2. **Offset paging.** The Data Table node has a limit and no offset, so a
 *    second page is not expressible with it at all.
 * 3. **Fewer fields.** An index should not ship whole records. Masking protects
 *    a value that travels; leaving the field out means it never does.
 *
 * The output is a single item, the envelope, so the branch ends with one
 * loopthink Result node in "One Object" mode.
 */

function toDate(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const time = new Date(value as string).getTime();
	return Number.isNaN(time) ? undefined : time;
}

function fieldList(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
}

interface RangeFilter {
	field: string;
	from?: string;
	to?: string;
}

export class LoopthinkPage implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink Page',
		name: 'loopthinkPage',
		icon: 'file:loopthink-mark.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ "sort " + $parameter["sortBy"] + " " + $parameter["sortDirection"] }}',
		description: 'Filters by date range, sorts, pages and trims rows into one index answer',
		defaults: { name: 'loopthink Page' },
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Sort By',
				name: 'sortBy',
				type: 'string',
				default: 'createdAt',
				description: 'Field to order on. Rows missing it keep their incoming order, at the end.',
			},
			{
				displayName: 'Direction',
				name: 'sortDirection',
				type: 'options',
				default: 'desc',
				options: [
					{ name: 'Newest First', value: 'desc' },
					{ name: 'Oldest First', value: 'asc' },
				],
			},
			{
				displayName: 'Offset',
				name: 'offset',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description: 'Rows to skip. Wire this to the tool parameter the model sends.',
			},
			{
				// Keep the effective value small when wiring a tool to it: the page
				// travels through the platform and has to fit inside the 25 seconds
				// the caller waits.
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'string',
				default: '',
				placeholder: 'ID, name, country, createdAt',
				description:
					'Comma-separated fields to keep. Empty returns whole rows, which an index rarely should.',
			},
			{
				displayName: 'Date Filters',
				name: 'dateFilters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Date Filter',
				description: 'Optional. A bound left empty is simply not applied, so an absent tool parameter needs no branching.',
				options: [
					{
						displayName: 'Filter',
						name: 'filters',
						values: [
							{
								displayName: 'Field',
								name: 'field',
								type: 'string',
								default: 'createdAt',
							},
							{
								displayName: 'From',
								name: 'from',
								type: 'string',
								default: '',
								description: 'Inclusive lower bound, any format Date understands',
							},
							{
								displayName: 'To',
								name: 'to',
								type: 'string',
								default: '',
								description: 'Inclusive upper bound',
							},
						],
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const rows = this.getInputData().map((item) => item.json as IDataObject);

		const sortBy = this.getNodeParameter('sortBy', 0, 'createdAt') as string;
		const direction = this.getNodeParameter('sortDirection', 0, 'desc') as 'asc' | 'desc';
		const offset = Math.max(0, Number(this.getNodeParameter('offset', 0, 0)) || 0);
		const limit = Math.max(1, Number(this.getNodeParameter('limit', 0, 50)) || 50);
		const fields = fieldList(this.getNodeParameter('fields', 0, ''));
		const filters = ((this.getNodeParameter('dateFilters', 0, {}) as IDataObject).filters ??
			[]) as RangeFilter[];

		const matches = (row: IDataObject): boolean =>
			filters.every((filter) => {
				const value = toDate(row[filter.field]);
				const from = toDate(filter.from);
				const to = toDate(filter.to);
				// A row without the field cannot satisfy a bound on it. Letting it
				// through would put records outside the requested window on the page.
				if (value === undefined) return from === undefined && to === undefined;
				if (from !== undefined && value < from) return false;
				if (to !== undefined && value > to) return false;
				return true;
			});

		const filtered = rows.filter(matches);

		const ordered = filtered
			.map((row, index) => ({ row, index }))
			.sort((a, b) => {
				const left = toDate(a.row[sortBy]) ?? (a.row[sortBy] as any);
				const right = toDate(b.row[sortBy]) ?? (b.row[sortBy] as any);
				if (left === undefined && right === undefined) return a.index - b.index;
				if (left === undefined) return 1;
				if (right === undefined) return -1;
				if (left === right) return a.index - b.index; // stable
				const order = left < right ? -1 : 1;
				return direction === 'asc' ? order : -order;
			})
			.map(({ row }) => row);

		const page = ordered.slice(offset, offset + limit).map((row) => {
			if (fields.length === 0) return row;
			const trimmed: IDataObject = {};
			for (const field of fields) {
				if (field in row) trimmed[field] = row[field];
			}
			return trimmed;
		});

		return [
			this.helpers.returnJsonArray([
				{
					items: page,
					total: filtered.length,
					offset,
					limit,
					// So a model knows to ask again without having to compare numbers.
					hasMore: offset + page.length < filtered.length,
				},
			]),
		];
	}
}
