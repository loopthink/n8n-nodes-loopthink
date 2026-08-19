/**
 * Turning a tool's parameters into something a Data Table node can filter on.
 *
 * Every parameter a model sends is optional, and the set differs per call. The
 * Data Table node wants the opposite: a fixed list of conditions, decided when
 * the workflow is built. The list cannot be supplied by an expression — n8n
 * walks a string handed to a multi-value collection character by character and
 * silently produces one empty condition per character — so the rows have to be
 * real, and each one has to hold *something* on every call.
 *
 * That is what this file produces: for a range, the bound that was sent or a
 * value so far outside it that the condition cannot exclude anything; for an
 * optional exact match, the value or a wildcard. The workflow keeps its fixed
 * rows and stops caring which parameters arrived.
 *
 * Every entry has the same two fields, `condition` and `value`, so every row in
 * the Data Table node is filled the same way whatever it filters on. Which
 * comparison a row needs is this file's decision, not something the person
 * building the workflow has to know: a range is a bound, an optional match is a
 * LIKE, and paging seeks past the cursor. Getting one of those wrong is silent —
 * an equals where a bound belongs still runs, it just answers with nothing.
 */

/**
 * Paging is always on `id`, and it is not configurable.
 *
 * n8n creates every data table with `id integer PRIMARY KEY`, alongside
 * `createdAt` and `updatedAt`; the three are guaranteed and `getColumns()` does
 * not even list them. So the cursor column is never in question, and asking for
 * it would only be a chance to name one that is not unique — which keyset paging
 * does not survive. A strict comparison on a column that repeats skips every row
 * sharing the boundary value, silently, at exactly one page boundary in a
 * listing that otherwise looks correct.
 *
 * Ordering by `id` is insertion order, which is what "newest first" means for a
 * table nobody backdates. Sorting by `createdAt` instead would gain nothing and
 * cost the guarantee.
 */
export const CURSOR_COLUMN = 'id';

/** Wider than any date a column can hold, so an absent bound excludes nothing. */
export const DATE_MIN = '0001-01-01T00:00:00.000Z';
export const DATE_MAX = '9999-12-31T23:59:59.999Z';
/** The largest integers a JS number represents exactly, which is also the widest a Data Table number goes. */
export const NUMBER_MIN = -9007199254740991;
export const NUMBER_MAX = 9007199254740991;

export type RangeType = 'date' | 'number';

export interface RangeSpec {
	/** The key this range appears under in the output. */
	column: string;
	/** Parameter prefix, when the tool does not name its parameters after the column. */
	parameter?: string;
	type: RangeType;
}

export interface MatchSpec {
	column: string;
	parameter?: string;
}

/** One Data Table condition row, ready to be pasted into two fields. */
export interface Comparison {
	condition: 'lt' | 'gt' | 'gte' | 'lte' | 'ilike';
	value: string | number;
}

export interface PreparedQuery {
	limit: number;
	order: 'ASC' | 'DESC';
	/**
	 * Parameters the tool declares that no row here consumes. A filter the model
	 * was invited to send and that quietly does nothing returns more rows than
	 * the caller asked for, and nothing else in the chain would say so.
	 */
	unused: string[];
	/** Keyed by column: `q.id`, `q.status`, and `q.createdAt_min` / `_max` for a range. */
	[key: string]: Comparison | number | string | string[];
}

/** Paging is the node's own business, never a filter. */
const RESERVED = ['limit', 'cursor', 'sort'];

const RANGE_SUFFIXES = { min: ['_after', '_from', '_min'], max: ['_before', '_to', '_max'] };

function firstDefined(params: Record<string, unknown>, names: string[]): unknown {
	for (const name of names) {
		const value = params[name];
		if (value !== undefined && value !== null && value !== '') return value;
	}
	return undefined;
}

/**
 * `sort` is a parameter a tool commonly offers, and honouring it here spares the
 * workflow the pair of ternaries that used to flip the order and the direction
 * of the cursor comparison in lockstep. Anything unrecognised leaves the
 * configured order alone.
 */
export function sortDirection(value: unknown, configured: 'ASC' | 'DESC'): 'ASC' | 'DESC' {
	const asked = String(value ?? '').toLowerCase();
	if (['oldest', 'asc', 'ascending'].includes(asked)) return 'ASC';
	if (['newest', 'desc', 'descending'].includes(asked)) return 'DESC';
	return configured;
}

/**
 * An exact match has no neutral value: `status = ''` matches nothing, which is
 * the opposite of "no filter". A case-insensitive LIKE does have one, so an
 * optional equality becomes a LIKE whose fallback is the wildcard. The value's
 * own wildcards are escaped, or a guest searching for `100%` would match
 * everything.
 */
export function likeValue(value: unknown): string {
	if (value === undefined || value === null || value === '') return '%';
	return String(value).replace(/([%_\\])/g, '\\$1');
}

export function prepareQuery(
	params: Record<string, unknown>,
	options: {
		defaultLimit: number;
		order: 'ASC' | 'DESC';
		ranges?: RangeSpec[];
		matches?: MatchSpec[];
	},
): PreparedQuery {
	const order = sortDirection(params.sort, options.order);
	const asked = Number(params.limit);
	const limit =
		Number.isFinite(asked) && asked > 0 ? Math.min(asked, options.defaultLimit) : options.defaultLimit;

	// Paging seeks strictly past the last row of the previous page. On the first
	// page there is no cursor, so the comparison starts at the far end and the
	// row keeps its place in the condition list.
	const openEnd = order === 'DESC' ? NUMBER_MAX : NUMBER_MIN;

	// Names this call accounts for; whatever is left over is reported below.
	const consumed = new Set(RESERVED);

	const query: PreparedQuery = {
		limit,
		order,
		unused: [],
		[CURSOR_COLUMN]: {
			condition: order === 'DESC' ? 'lt' : 'gt',
			value: (params.cursor as string | number) ?? openEnd,
		},
	};

	for (const range of options.ranges ?? []) {
		const prefix = range.parameter || range.column;
		[...RANGE_SUFFIXES.min, ...RANGE_SUFFIXES.max].forEach((s) => consumed.add(prefix + s));
		const min = firstDefined(params, RANGE_SUFFIXES.min.map((s) => prefix + s));
		const max = firstDefined(params, RANGE_SUFFIXES.max.map((s) => prefix + s));
		const wide = range.type === 'date' ? [DATE_MIN, DATE_MAX] : [NUMBER_MIN, NUMBER_MAX];
		// Two rows, so two keys. A range is the one thing a single column cannot
		// express in one condition.
		query[`${range.column}_min`] = { condition: 'gte', value: (min ?? wide[0]) as string | number };
		query[`${range.column}_max`] = { condition: 'lte', value: (max ?? wide[1]) as string | number };
	}

	for (const match of options.matches ?? []) {
		const name = match.parameter || match.column;
		consumed.add(name);
		query[match.column] = { condition: 'ilike', value: likeValue(params[name]) };
	}

	query.unused = Object.keys(params).filter((name) => !consumed.has(name));
	return query;
}
