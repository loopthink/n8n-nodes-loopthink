import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { MissingSecretError, secretsFromCredential, substituteSecrets } from '../LoopthinkRunner/secrets';

/**
 * Execute Request — issues the HTTP call loopthink already resolved.
 *
 * This is the one thing a standard HTTP Request node cannot do here. loopthink
 * stores the *shape* of a call and writes `{{secret.NAME}}` where a value
 * belongs, so the platform never holds a key for a customer's own system. Handed
 * to a plain HTTP node, that placeholder travels to the target verbatim and ends
 * up in someone's access log. Substitution has to happen inside a node that
 * knows about it, and it happens here and nowhere else.
 *
 * It sits next to Send Result rather than in the Runner because that is where
 * the secrets belong: a workflow that only answers Data Table tools should not
 * have to carry a credential for an API it never calls.
 */

interface HttpRequest {
	method?: string;
	url?: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
}

export const executeFields: INodeProperties[] = [
	{
		displayName: 'Request',
		name: 'httpRequest',
		type: 'json',
		default: "={{ $json.request }}",
		description:
			'The resolved call from the Runner. Leave this as it is unless the branch reshapes the item first.',
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'requestTimeout',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 120 },
		default: 30,
		description: 'How long to wait for the internal API before giving up',
	},
	{
		displayName:
			'Keys for your own systems stay in this n8n. Write <code>{{secret.NAME}}</code> in loopthink where a value belongs and add a matching entry under <b>Secrets</b>. A call whose placeholder has no entry is refused rather than sent, because the literal placeholder would reach the target and sit in its log.',
		name: 'executeNotice',
		type: 'notice',
		default: '',
	},
];

function parseRequest(value: unknown): HttpRequest {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as HttpRequest;
		} catch {
			return {};
		}
	}
	return (value ?? {}) as HttpRequest;
}

export async function executeRequest(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const timeout = (this.getNodeParameter('requestTimeout', 0, 30) as number) * 1000;

	// Optional: a server may point at an API that needs no secret at all.
	let secrets: Record<string, string> = {};
	try {
		secrets = secretsFromCredential(await this.getCredentials('loopthinkTargetApi'));
	} catch {
		// Not configured. A request carrying no placeholder still works.
	}

	const out: INodeExecutionData[] = [];

	for (let i = 0; i < this.getInputData().length; i += 1) {
		const request = parseRequest(this.getNodeParameter('httpRequest', i));
		if (!request.url) {
			throw new NodeOperationError(this.getNode(), 'No url in the Request parameter', {
				description:
					'This operation runs the HTTP call loopthink resolved. A workflow tool has no url, so route those to their own branch instead.',
			});
		}

		try {
			// Filled in here and nowhere else. `resolved` must never be logged or
			// emitted: it holds the actual secrets.
			const resolved = substituteSecrets(request as Required<HttpRequest>, secrets);

			// Assembled after substitution. Encoding first would hide a
			// {{secret.NAME}} behind %7B%7B…%7D%7D, and it would travel to the
			// target unresolved and unreported.
			const url = new URL(resolved.url);
			Object.entries(resolved.query || {}).forEach(([key, value]) =>
				url.searchParams.set(key, String(value)),
			);

			const response = await this.helpers.httpRequest({
				method: (resolved.method || 'GET') as any,
				url: url.toString(),
				headers: resolved.headers || {},
				body: resolved.body ?? undefined,
				json: true,
				timeout,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});

			out.push({
				json: {
					status: response.statusCode,
					data: response.body as IDataObject,
					// The queued form, placeholders unresolved: a substituted URL can
					// hold a secret, and n8n stores execution data.
					url: request.url,
					method: request.method ?? 'GET',
				},
			});
		} catch (error) {
			if (error instanceof MissingSecretError) {
				this.logger.warn(`loopthink: ${error.message}`);
			}
			// Passed on rather than thrown, so the branch can still answer. The
			// caller in the cloud is blocking and would otherwise wait out its
			// full timeout for something that already failed.
			out.push({ json: { error: (error as Error).message, url: request.url } });
		}
	}

	return [out];
}
