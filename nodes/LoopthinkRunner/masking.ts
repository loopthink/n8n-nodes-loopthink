/**
 * Data masking, applied to every result before it leaves this network.
 *
 * A port of the engine that runs in the loopthink cloud, so a rule means the same
 * thing wherever it is enforced. The *rules* are not baked in here — they arrive
 * with each queued request, so a rule added in loopthink takes effect on the very
 * next tool call without touching n8n.
 *
 * One deliberate divergence: a null in a masked field stays null here. The cloud
 * engine currently stringifies it first and returns the masked string "n**l",
 * inventing a value where there is none. Fix pending there; this side is correct
 * already, and matching a bug would be the wrong kind of fidelity.
 *
 * Note the regexes carry `g` and are shared. That is safe with `match()` and
 * `replace()`, which reset `lastIndex` themselves; switching to `test()` or
 * `exec()` would make every second call return the wrong answer.
 */

export type MaskingStrategy = 'mask' | 'pseudonymize' | 'remove';
export type MaskingPattern = 'email' | 'iban' | 'phone';

export interface MaskingRule {
	field?: string;
	pattern?: MaskingPattern;
	strategy: MaskingStrategy;
	scope?: string;
}

const PATTERN_REGEX: Record<MaskingPattern, RegExp> = {
	email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
	iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
	phone: /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,5}\d{2,4}/g,
};

// Deterministic, so the model can still reason about "the same customer"
// across a result set without ever seeing the real value.
function pseudonymize(value: string): string {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return `pseudo_${(hash >>> 0).toString(36)}`;
}

function maskValue(value: string): string {
	if (value.length <= 2) return '*'.repeat(value.length);
	return `${value[0]}${'*'.repeat(Math.max(1, value.length - 2))}${value[value.length - 1]}`;
}

function applyStrategyToString(value: string, strategy: MaskingStrategy): string | undefined {
	switch (strategy) {
		case 'remove':
			return undefined;
		case 'pseudonymize':
			return pseudonymize(value);
		case 'mask':
		default:
			return maskValue(value);
	}
}

function applyPatternToString(value: string, rule: MaskingRule): string {
	const regex = PATTERN_REGEX[rule.pattern as MaskingPattern];
	if (!regex) return value;
	return value.replace(regex, (match) => {
		const replaced = applyStrategyToString(match, rule.strategy);
		return replaced === undefined ? '' : replaced;
	});
}

function normalizeFieldRules(rules: MaskingRule[]): Map<string, MaskingRule> {
	const map = new Map<string, MaskingRule>();
	rules.filter((r) => r.field).forEach((r) => map.set(String(r.field).toLowerCase(), r));
	return map;
}

function normalizeScope(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

/**
 * Unscoped rules always apply. Scoped ones only when the target is known and
 * matches — so an entity rule on "contacts" never leaks onto "companies", and
 * never fires on a result whose origin cannot be attributed.
 */
export function rulesForScope(rules: MaskingRule[], scope?: string): MaskingRule[] {
	if (!rules || rules.length === 0) return [];
	const normalized = scope ? normalizeScope(scope) : undefined;
	return rules.filter(
		(r) => !r.scope || (normalized !== undefined && normalizeScope(r.scope) === normalized),
	);
}

export function applyMasking<T = any>(data: T, rules: MaskingRule[]): T {
	if (!rules || rules.length === 0) return data;

	const fieldRules = normalizeFieldRules(rules);
	const patternRules = rules.filter((r) => r.pattern);

	const walk = (value: any, keyName?: string): any => {
		if (value === null || value === undefined) return value;

		if (Array.isArray(value)) return value.map((item) => walk(item, keyName));

		if (typeof value === 'object') {
			const out: Record<string, any> = {};
			Object.keys(value).forEach((k) => {
				const rule = fieldRules.get(k.toLowerCase());
				if (rule) {
					if (rule.strategy === 'remove') return;
					// null stays null: stringifying it here would turn "no value"
					// into the masked string "n**l" and invent data that is not there.
					if (value[k] === null || value[k] === undefined) {
						out[k] = value[k];
						return;
					}
					out[k] = applyStrategyToString(String(value[k]), rule.strategy);
				} else {
					out[k] = walk(value[k], k);
				}
			});
			return out;
		}

		if (typeof value === 'string') {
			return patternRules.reduce((acc, rule) => applyPatternToString(acc, rule), value);
		}

		return value;
	};

	return walk(data);
}
