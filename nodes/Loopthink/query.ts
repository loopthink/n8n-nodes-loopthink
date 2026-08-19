/**
 * Turning a tool's parameters into values a Data Table node can filter on.
 *
 * Every parameter a model sends is optional, and the set differs per call. The
 * Data Table node wants the opposite: a fixed list of conditions, decided when
 * the workflow is built. The list cannot be supplied by an expression, because
 * n8n walks a string handed to a multi-value collection character by character
 * and silently produces one empty condition per character. So the rows have to
 * be real, and each one has to hold something on every call.
 *
 * That is all this file does: for a range, the bound that was sent or a value so
 * far outside it that the comparison cannot exclude anything; for an optional
 * match, the value or a wildcard. One key, one value, nothing nested. Which
 * comparison a row uses is chosen once in the Data Table node and never changes,
 * so it does not belong here.
 *
 * There is deliberately no cursor. Continuing a listing is a filter like any
 * other: a range on `id`, driven by the model, which reads the last id it saw
 * and asks for the ones after it. That needs no protocol, no opaque token and no
 * special case here, and it lets the model narrow or bisect instead of only
 * walking forward.
 */

/** Wider than any date a column can hold, so an absent bound excludes nothing. */
export const DATE_MIN = '0001-01-01T00:00:00.000Z';
export const DATE_MAX = '9999-12-31T23:59:59.999Z';
/** The largest integers a JS number represents exactly, which is also the widest a Data Table number goes. */
export const NUMBER_MIN = -9007199254740991;
export const NUMBER_MAX = 9007199254740991;

/** Paging and ordering are the node's own business, never a filter. */
const RESERVED = ['limit', 'sort'];

export type RangeType = 'date' | 'number';

export interface RangeSpec {
	/** The column, and the stem of the two keys this yields. */
	column: string;
	/** Parameter prefix, when the tool does not name its parameters after the column. */
	parameter?: string;
	type: RangeType;
}

export interface MatchSpec {
	column: string;
	parameter?: string;
}

export interface PreparedQuery {
	/** How many rows to answer with. */
	limit: number;
	/**
	 * One more than the limit. The Data Table node reads this, so the extra row
	 * is the evidence that there was more; Send Result drops it and says so.
	 * Cheaper and more exact than a second query for a total.
	 */
	fetch: number;
	order: 'ASC' | 'DESC';
	/** Parameters the tool declares that no row here reads. */
	unused: string[];
	/** `q.createdAt_min`, `q.createdAt_max`, `q.status`: a value per condition row. */
	[key: string]: number | string | string[];
}

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
 * workflow a ternary in the Data Table node's Order field.
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
	const asked = Number(params.limit);
	const limit =
		Number.isFinite(asked) && asked > 0
			? Math.min(asked, options.defaultLimit)
			: options.defaultLimit;

	// Names this call accounts for; whatever is left over is reported below.
	const consumed = new Set(RESERVED);

	const query: PreparedQuery = {
		limit,
		fetch: limit + 1,
		order: sortDirection(params.sort, options.order),
		unused: [],
	};

	for (const range of options.ranges ?? []) {
		const prefix = range.parameter || range.column;
		[...RANGE_SUFFIXES.min, ...RANGE_SUFFIXES.max].forEach((s) => consumed.add(prefix + s));
		const min = firstDefined(params, RANGE_SUFFIXES.min.map((s) => prefix + s));
		const max = firstDefined(params, RANGE_SUFFIXES.max.map((s) => prefix + s));
		const wide = range.type === 'date' ? [DATE_MIN, DATE_MAX] : [NUMBER_MIN, NUMBER_MAX];
		query[`${range.column}_min`] = (min ?? wide[0]) as number | string;
		query[`${range.column}_max`] = (max ?? wide[1]) as number | string;
	}

	for (const match of options.matches ?? []) {
		const name = match.parameter || match.column;
		consumed.add(name);
		query[match.column] = likeValue(params[name]);
	}

	query.unused = Object.keys(params).filter((name) => !consumed.has(name));
	return query;
}
