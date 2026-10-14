import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { applyMasking, rulesForScope } from '../LoopthinkRunner/masking';
import { budgetedBody, parseRequest, postAnswer } from './answer';

/**
 * Call MCP Server — proxies a server only this network can reach.
 *
 * A loopthink server of type "MCP server" running on a pull runner has no URL
 * and no credential on the platform side: the upstream lives here. What
 * arrives is the JSON-RPC request the platform wants forwarded, `tools/list`
 * when an admin approves tools and `tools/call` for every call, and this
 * operation opens the session, forwards it, unwraps the answer, masks it with
 * the rules that travelled along and sends it back. One node, no Switch: the
 * platform already decided which tools exist, so there is nothing to route.
 *
 * It answers the call itself rather than handing data to Send Result, because
 * a tool's answer is not always a list of objects, which is the only thing an
 * n8n item can carry. A string, a number, an array of strings all come back
 * from MCP servers and all have to travel as they are.
 */

const PROTOCOL_VERSION = '2025-06-18';

// Inside the 25 s the platform waits for an answer, with room for the
// initialize round trip and the POST back.
const UPSTREAM_TIMEOUT_MS = 20_000;

type Rpc = { jsonrpc: '2.0'; id?: string; method?: string; params?: unknown; result?: any; error?: { message?: string } };

export const mcpFields: INodeProperties[] = [
	{
		displayName: 'Request',
		name: 'request',
		type: 'json',
		default: "={{ $('loopthink Runner').first().json }}",
		description:
			'The queued request this forwards. Leave this as it is unless you renamed the Runner node, in which case put its name in the expression.',
	},
	{
		displayName: 'Server URL',
		name: 'serverUrl',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'http://mcp.internal:8080/mcp',
		description:
			'The MCP endpoint (Streamable HTTP) inside your network. It is never sent to loopthink; the platform only ever sees the tools it answers with.',
	},
	{
		displayName: 'MCP Server Authentication',
		name: 'serverAuthentication',
		type: 'options',
		default: 'none',
		options: [
			{ name: 'None', value: 'none' },
			{ name: 'Header Auth', value: 'headerAuth', description: 'A named header, e.g. X-API-Key' },
			{ name: 'Bearer Token', value: 'bearerAuth', description: 'Sent as Authorization: Bearer …' },
		],
		description:
			'How the MCP server itself is authenticated; the credential stays in n8n. The loopthink Runner credential above is separate: it is what the answer travels back through.',
	},
	{
		displayName:
			'Every tool the platform approved is forwarded as it arrives. The result is masked here, inside your network, with the rules configured for that tool in loopthink, before anything is sent back. A tools/list request answers with the server\'s tools so they can be approved in loopthink.',
		name: 'mcpNotice',
		type: 'notice',
		default: '',
	},
];

/** The readable text of a CallToolResult's content blocks. */
function contentText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text as string)
		.join('\n');
}

/**
 * The data behind a CallToolResult, unwrapped the way the platform's own proxy
 * unwraps it, so a tool answers the same whichever side opened the session:
 * structuredContent when declared, otherwise the text parsed as JSON when it
 * is JSON, otherwise the text. A failing call (isError) throws with the
 * upstream tool's own words.
 */
export function unwrapCallToolResult(result: any): unknown {
	if (result?.isError) {
		throw new Error(contentText(result.content) || 'The upstream tool reported an error');
	}
	if (result?.structuredContent !== undefined && result?.structuredContent !== null) {
		const structured = result.structuredContent;
		// loopthink's own connectors wrap results as { result } to satisfy their
		// output schema; unwrap that one shape so a loopthink-behind-loopthink
		// chain does not nest a wrapper per hop.
		return typeof structured === 'object' &&
			!Array.isArray(structured) &&
			'result' in structured &&
			Object.keys(structured).length === 1
			? structured.result
			: structured;
	}
	const text = contentText(result?.content);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * The JSON-RPC message with the given id in an upstream reply. Streamable HTTP
 * allows two encodings of the same thing: application/json, one message, and
 * text/event-stream, the message in SSE `data:` lines, possibly after
 * notifications that are not it.
 */
export function parseRpcResponse(contentType: string, body: unknown, id: string): Rpc | null {
	if (String(contentType).includes('text/event-stream')) {
		const raw = typeof body === 'string' ? body : JSON.stringify(body);
		for (const event of raw.split(/\r?\n\r?\n/)) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice('data:'.length).trim())
				.join('\n');
			if (!data) continue;
			try {
				const message = JSON.parse(data);
				if (message && message.id === id) return message as Rpc;
			} catch {
				// A malformed event between valid ones is the upstream's problem.
			}
		}
		return null;
	}

	let message: any = body;
	if (typeof body === 'string') {
		try {
			message = JSON.parse(body);
		} catch {
			return null;
		}
	}
	if (Array.isArray(message)) return (message as Rpc[]).find((m) => m && m.id === id) ?? null;
	return message && message.id === id ? (message as Rpc) : null;
}

interface Session {
	url: string;
	headers: Record<string, string>;
}

/**
 * The minimal client: initialize, the initialized notification, then the one
 * request. Stateless on purpose: a session per call is three short POSTs, and
 * cheaper than being wrong about how long an upstream keeps one.
 */
class McpClient {
	private session: Session;

	constructor(
		private readonly ctx: IExecuteFunctions,
		url: string,
		auth: Record<string, string>,
	) {
		this.session = {
			url,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				...auth,
			},
		};
	}

	private async post(message: Rpc): Promise<{ status: number; contentType: string; body: unknown; headers: IDataObject }> {
		const options: IHttpRequestOptions = {
			method: 'POST',
			url: this.session.url,
			headers: this.session.headers,
			body: JSON.stringify(message),
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: UPSTREAM_TIMEOUT_MS,
		};
		const response = (await this.ctx.helpers.httpRequest(options)) as IDataObject;
		const headers = (response.headers ?? {}) as IDataObject;
		return {
			status: Number(response.statusCode ?? 0),
			contentType: String(headers['content-type'] ?? ''),
			body: response.body,
			headers,
		};
	}

	private static failure(status: number): Error {
		if (status === 401 || status === 403) {
			return new Error(`The MCP server rejected the credential (HTTP ${status})`);
		}
		return new Error(`The MCP server answered HTTP ${status}`);
	}

	async initialize(): Promise<void> {
		const response = await this.post({
			jsonrpc: '2.0',
			id: 'init',
			method: 'initialize',
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'loopthink-n8n-runner', version: '1.0.0' },
			},
		});
		if (response.status < 200 || response.status >= 300) throw McpClient.failure(response.status);

		const init = parseRpcResponse(response.contentType, response.body, 'init');
		if (!init || init.error) {
			throw new Error(`The MCP server refused to initialize${init?.error ? `: ${init.error.message}` : ''}`);
		}

		const sessionId = response.headers['mcp-session-id'];
		if (sessionId) this.session.headers['Mcp-Session-Id'] = String(sessionId);
		const negotiated = init.result?.protocolVersion;
		this.session.headers['MCP-Protocol-Version'] =
			typeof negotiated === 'string' && negotiated ? negotiated : PROTOCOL_VERSION;

		// Required before normal requests; a stateless upstream may answer 202,
		// 404 or nothing at all, none of which is a failure.
		try {
			await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		} catch {
			// Ignored on purpose.
		}
	}

	async request(id: string, method: string, params: unknown): Promise<any> {
		const response = await this.post({ jsonrpc: '2.0', id, method, params });
		if (response.status < 200 || response.status >= 300) throw McpClient.failure(response.status);
		const message = parseRpcResponse(response.contentType, response.body, id);
		if (!message) throw new Error('The MCP server sent no response to the request');
		if (message.error) throw new Error(`MCP server error: ${message.error.message}`);
		return message.result;
	}

	/** Every page of tools/list in one array, the way the platform expects it. */
	async listAllTools(): Promise<unknown[]> {
		const tools: unknown[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page += 1) {
			const result = await this.request(`tools-${page}`, 'tools/list', cursor ? { cursor } : {});
			if (Array.isArray(result?.tools)) tools.push(...result.tools);
			cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
			if (!cursor) break;
		}
		return tools;
	}
}

async function authHeaders(ctx: IExecuteFunctions): Promise<Record<string, string>> {
	const mode = ctx.getNodeParameter('serverAuthentication', 0) as string;
	if (mode === 'headerAuth') {
		const credential = await ctx.getCredentials('httpHeaderAuth');
		const name = String(credential.name ?? '').trim();
		return name ? { [name]: String(credential.value ?? '') } : {};
	}
	if (mode === 'bearerAuth') {
		const credential = await ctx.getCredentials('httpBearerAuth');
		const token = String(credential.token ?? '').trim();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}
	return {};
}

export async function executeMcp(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const request = parseRequest(this.getNodeParameter('request', 0));
	const requestId = request.requestId;
	if (!requestId) {
		throw new NodeOperationError(this.getNode(), 'No requestId in the Request parameter', {
			description:
				'It should point at the loopthink Runner node that claimed this call. If you renamed that node, update the expression to match.',
		});
	}

	const method = request.method;
	const params = (request.params ?? {}) as IDataObject;
	const serverUrl = String(this.getNodeParameter('serverUrl', 0) ?? '').trim();
	const rules = rulesForScope(request.masking ?? [], request.scope ?? undefined);

	let body: IDataObject;
	let failure: string | undefined;
	try {
		if (method !== 'tools/list' && method !== 'tools/call') {
			throw new Error(
				`This call is not for an MCP server (it carries ${method ? `"${method}"` : 'no method'}). ` +
					'Call MCP Server answers servers of type "MCP server"; route other tools to a branch that answers them.',
			);
		}
		if (!serverUrl) throw new Error('No Server URL configured on the Call MCP Server node');

		const client = new McpClient(this, serverUrl, await authHeaders(this));
		await client.initialize();

		const data =
			method === 'tools/list'
				? { tools: await client.listAllTools() }
				: unwrapCallToolResult(await client.request('call', 'tools/call', params));

		// The one place masking happens for a proxied tool. A listing arrives
		// with no rules, so the descriptions reach the admin as they are.
		body = budgetedBody(applyMasking(data, rules), 200);
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
		// The waiting caller gets the reason now rather than a timeout later.
		body = { error: failure };
	}

	const response = await postAnswer(this, requestId, body);

	// Answered, and then failed on purpose: the model already has the reason,
	// and the execution turning red is how whoever runs this n8n learns that a
	// server in their network is refusing calls.
	if (failure) {
		throw new NodeOperationError(this.getNode(), failure, {
			description: `The error was sent back to loopthink as the answer to request ${requestId}.`,
		});
	}

	return [
		this.helpers.returnJsonArray([
			{
				requestId,
				method: method ?? null,
				tool: request.tool ?? null,
				status: body.status ?? null,
				error: body.error ?? null,
				maskingRules: rules.length,
				accepted: response.accepted ?? null,
				duplicate: response.duplicate ?? null,
				sent: body.data ?? null,
			},
		]),
	];
}
