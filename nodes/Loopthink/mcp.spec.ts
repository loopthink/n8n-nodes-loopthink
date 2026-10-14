import { expect } from 'chai';

import { executeMcp, parseRpcResponse, unwrapCallToolResult } from './mcp.operation';

/**
 * The proxy, exercised through the node: an upstream that speaks Streamable
 * HTTP on one side, the queue on the other, and the body that reaches the queue
 * is what these assert on. That body is the whole contract with the platform.
 */

interface Posted {
	url: string;
	headers: Record<string, string>;
	body: any;
}

interface Upstream {
	/** Answers a JSON-RPC request by method. Return a result, or `{ error }`. */
	answer: (method: string, params: any, headers: Record<string, string>) => any;
	/** Encode replies as SSE rather than JSON. */
	sse?: boolean;
	sessionId?: string;
	status?: number;
}

function context(options: {
	request: Record<string, unknown>;
	upstream: Upstream;
	authentication?: string;
	credential?: Record<string, string>;
	serverUrl?: string;
}) {
	const posted: Posted[] = [];
	const upstreamCalls: Posted[] = [];
	const params: Record<string, any> = {
		request: options.request,
		serverUrl: options.serverUrl ?? 'http://mcp.internal/mcp',
		serverAuthentication: options.authentication ?? 'none',
	};

	const ctx = {
		getNodeParameter: (name: string) => params[name],
		getNode: () => ({ name: 'loopthink' }),
		getCredentials: async (type: string) => {
			if (type === 'loopthinkRunnerApi') {
				return { queueUrl: 'https://queue.example/', workspaceId: 'ws', groupId: 'grp', secret: 's' };
			}
			return options.credential ?? {};
		},
		helpers: {
			httpRequest: async (request: any) => {
				if (request.url.startsWith('https://queue.example/')) {
					posted.push({ url: request.url, headers: request.headers, body: request.body });
					return { accepted: true };
				}
				const message = JSON.parse(request.body);
				upstreamCalls.push({ url: request.url, headers: request.headers, body: message });
				const status = options.upstream.status ?? 200;
				// A notification has no id and gets no body.
				if (message.id === undefined) return { statusCode: 202, headers: {}, body: '' };
				let payload: any;
				if (message.method === 'initialize') {
					payload = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } };
				} else {
					const answer = options.upstream.answer(message.method, message.params, request.headers);
					payload =
						answer && answer.error
							? { jsonrpc: '2.0', id: message.id, error: answer.error }
							: { jsonrpc: '2.0', id: message.id, result: answer };
				}
				const headers: Record<string, string> = options.upstream.sse
					? { 'content-type': 'text/event-stream' }
					: { 'content-type': 'application/json' };
				if (options.upstream.sessionId && message.method === 'initialize') {
					headers['mcp-session-id'] = options.upstream.sessionId;
				}
				const body = options.upstream.sse
					? `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`
					: JSON.stringify(payload);
				return { statusCode: status, headers, body };
			},
			returnJsonArray: (rows: any[]) => rows.map((json) => ({ json })),
		},
	} as any;

	return { ctx, posted, upstreamCalls };
}

const callRequest = (overrides: Record<string, unknown> = {}) => ({
	requestId: 'req-1',
	tool: 'get_orders',
	method: 'tools/call',
	params: { name: 'get_orders', arguments: { limit: 2 } },
	masking: [{ field: 'email', strategy: 'remove', scope: 'get_orders' }],
	scope: 'get_orders',
	...overrides,
});

describe('Call MCP Server', () => {
	it('forwards tools/call as it arrived and answers with the masked data', async () => {
		const { ctx, posted, upstreamCalls } = context({
			request: callRequest(),
			upstream: {
				answer: (method, params) => {
					expect(method).to.equal('tools/call');
					expect(params).to.deep.equal({ name: 'get_orders', arguments: { limit: 2 } });
					return {
						content: [{ type: 'text', text: JSON.stringify([{ id: 1, email: 'a@b.c' }]) }],
					};
				},
			},
		});

		const [items] = await executeMcp.call(ctx);

		expect(posted).to.have.length(1);
		expect(posted[0].url).to.equal('https://queue.example/group/ws/grp/runner/request/req-1/result');
		expect(posted[0].body).to.deep.equal({ status: 200, data: [{ id: 1 }] });
		// initialize, the initialized notification, then the call.
		expect(upstreamCalls.map((c) => c.body.method)).to.deep.equal([
			'initialize',
			'notifications/initialized',
			'tools/call',
		]);
		expect(items[0].json.sent).to.deep.equal([{ id: 1 }]);
		expect(items[0].json.maskingRules).to.equal(1);
	});

	it('prefers structuredContent and unwraps a loopthink { result } wrapper', async () => {
		const { ctx, posted } = context({
			request: callRequest({ masking: [] }),
			upstream: {
				answer: () => ({
					content: [{ type: 'text', text: 'ignored' }],
					structuredContent: { result: { total: 3 } },
				}),
			},
		});

		await executeMcp.call(ctx);
		expect(posted[0].body).to.deep.equal({ status: 200, data: { total: 3 } });
	});

	it('answers a listing with every page of tools', async () => {
		const { ctx, posted } = context({
			request: { requestId: 'req-2', tool: 'tools/list', method: 'tools/list', params: {}, masking: [] },
			upstream: {
				answer: (method, params) => {
					expect(method).to.equal('tools/list');
					if (!params.cursor) return { tools: [{ name: 'a' }], nextCursor: 'p2' };
					return { tools: [{ name: 'b', description: 'mail me at x@y.z' }] };
				},
			},
		});

		await executeMcp.call(ctx);
		expect(posted[0].body).to.deep.equal({
			status: 200,
			data: { tools: [{ name: 'a' }, { name: 'b', description: 'mail me at x@y.z' }] },
		});
	});

	it('reads SSE-encoded replies and keeps the session id', async () => {
		const { ctx, posted, upstreamCalls } = context({
			request: callRequest({ masking: [] }),
			upstream: {
				sse: true,
				sessionId: 'sess-9',
				answer: () => ({ content: [{ type: 'text', text: 'plain text answer' }] }),
			},
		});

		await executeMcp.call(ctx);
		expect(posted[0].body).to.deep.equal({ status: 200, data: 'plain text answer' });
		const call = upstreamCalls.find((c) => c.body.method === 'tools/call')!;
		expect(call.headers['Mcp-Session-Id']).to.equal('sess-9');
		expect(call.headers['MCP-Protocol-Version']).to.equal('2025-03-26');
	});

	it('sends the credential from n8n, never from the request', async () => {
		const { ctx, upstreamCalls } = context({
			request: callRequest({ masking: [] }),
			authentication: 'headerAuth',
			credential: { name: 'X-API-Key', value: 'k-1' },
			upstream: { answer: () => ({ content: [] }) },
		});

		await executeMcp.call(ctx);
		for (const call of upstreamCalls) expect(call.headers['X-API-Key']).to.equal('k-1');
	});

	it('answers an upstream tool error with its words and fails the execution', async () => {
		const { ctx, posted } = context({
			request: callRequest({ masking: [] }),
			upstream: {
				answer: () => ({ isError: true, content: [{ type: 'text', text: 'order 7 does not exist' }] }),
			},
		});

		let thrown: any;
		try {
			await executeMcp.call(ctx);
		} catch (e) {
			thrown = e;
		}
		expect(thrown?.message).to.equal('order 7 does not exist');
		expect(posted).to.have.length(1);
		expect(posted[0].body).to.deep.equal({ error: 'order 7 does not exist' });
	});

	it('answers a refused credential as an error rather than a timeout', async () => {
		const { ctx, posted } = context({
			request: callRequest({ masking: [] }),
			upstream: { status: 401, answer: () => ({}) },
		});

		let thrown: any;
		try {
			await executeMcp.call(ctx);
		} catch (e) {
			thrown = e;
		}
		expect(thrown?.message).to.match(/rejected the credential \(HTTP 401\)/);
		expect(posted[0].body.error).to.match(/HTTP 401/);
	});

	it('refuses a call that is not for an MCP server, and says so to the caller', async () => {
		const { ctx, posted } = context({
			request: { requestId: 'req-3', tool: 'bookings_index', params: { limit: 5 }, masking: [] },
			upstream: { answer: () => ({}) },
		});

		let thrown: any;
		try {
			await executeMcp.call(ctx);
		} catch (e) {
			thrown = e;
		}
		expect(thrown?.message).to.match(/not for an MCP server/);
		expect(posted[0].body.error).to.match(/not for an MCP server/);
	});
});

describe('Unwrapping a CallToolResult', () => {
	it('parses JSON text and leaves other text alone', () => {
		expect(unwrapCallToolResult({ content: [{ type: 'text', text: '{"a":1}' }] })).to.deep.equal({ a: 1 });
		expect(unwrapCallToolResult({ content: [{ type: 'text', text: 'hello' }] })).to.equal('hello');
	});

	it('passes structuredContent through unless it is the one-key wrapper', () => {
		expect(unwrapCallToolResult({ structuredContent: { result: 1, other: 2 } })).to.deep.equal({
			result: 1,
			other: 2,
		});
		expect(unwrapCallToolResult({ structuredContent: [1, 2] })).to.deep.equal([1, 2]);
	});
});

describe('Parsing an upstream reply', () => {
	it('finds the message by id in a batch', () => {
		const body = JSON.stringify([
			{ jsonrpc: '2.0', id: 'x', result: 1 },
			{ jsonrpc: '2.0', id: 'y', result: 2 },
		]);
		expect(parseRpcResponse('application/json', body, 'y')?.result).to.equal(2);
	});

	it('skips a malformed SSE event and still finds the reply', () => {
		const body = 'data: {not json\n\ndata: {"jsonrpc":"2.0","id":"z","result":3}\n\n';
		expect(parseRpcResponse('text/event-stream; charset=utf-8', body, 'z')?.result).to.equal(3);
	});
});
