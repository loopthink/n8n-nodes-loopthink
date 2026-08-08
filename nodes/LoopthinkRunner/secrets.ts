/**
 * Placeholder substitution.
 *
 * loopthink stores the shape of a request and writes `{{secret.NAME}}` where a
 * value belongs. The values live here, in this n8n, and are filled in on the way
 * out — so the platform never holds a credential for a customer's own system.
 *
 * Substitution runs only over what loopthink sent (url, header values, body).
 * It never touches a response, so nothing in returned data can be mistaken for a
 * placeholder and rewritten.
 */

const PLACEHOLDER = /\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export class MissingSecretError extends Error {
	constructor(public readonly names: string[]) {
		super(
			`Missing secret${names.length > 1 ? 's' : ''} in the runner credential: ${names.join(', ')}. ` +
				'Add them under "loopthink Target Secrets".',
		);
		this.name = 'MissingSecretError';
	}
}

/** Every placeholder name used anywhere in the value, without duplicates. */
export function collectPlaceholders(value: unknown, found: Set<string> = new Set()): Set<string> {
	if (typeof value === 'string') {
		for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
		return found;
	}
	if (Array.isArray(value)) {
		value.forEach((v) => collectPlaceholders(v, found));
		return found;
	}
	if (value && typeof value === 'object') {
		Object.values(value as Record<string, unknown>).forEach((v) => collectPlaceholders(v, found));
	}
	return found;
}

function substituteString(value: string, secrets: Record<string, string>): string {
	return value.replace(PLACEHOLDER, (_full, name: string) => secrets[name]);
}

/**
 * Replaces every placeholder, or throws naming the ones that are missing.
 *
 * Fails closed on purpose. Sending the literal `{{secret.CRM_API_KEY}}` would
 * earn a 401 from the target, leave the placeholder in its access log, and give
 * whoever debugs it no idea what went wrong.
 */
export function substituteSecrets<T>(value: T, secrets: Record<string, string>): T {
	const missing = [...collectPlaceholders(value)].filter((name) => !secrets[name]);
	if (missing.length) throw new MissingSecretError(missing);

	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') return substituteString(v, secrets);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') {
			return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
		}
		return v;
	};

	return walk(value) as T;
}

/** Flattens the credential's name/value list into a lookup. */
export function secretsFromCredential(credential: unknown): Record<string, string> {
	const entries = (credential as any)?.secrets?.secret;
	if (!Array.isArray(entries)) return {};

	const out: Record<string, string> = {};
	for (const entry of entries) {
		const name = String(entry?.name || '').trim();
		// A blank value is treated as absent, so a half-filled row fails loudly at
		// the missing-secret check instead of silently sending an empty header.
		if (name && entry?.value) out[name] = String(entry.value);
	}
	return out;
}
