import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import WebSocket from 'ws';

import { applyMasking, rulesForScope, type MaskingRule } from '../LoopthinkRunner/masking';
import { MissingSecretError, secretsFromCredential, substituteSecrets } from '../LoopthinkRunner/secrets';

/**
 * loopthink Runner (WebSocket) — the same runner, told instead of asking.
 *
 * The polling node spends a request per interval per runner, forever, to hear
 * "nothing". This one holds a single outbound connection and is pushed a request
 * the moment it is enqueued: no latency from a poll interval, and a cost that is
 * connection-minutes rather than requests.
 *
 * Everything downstream is shared with the polling node — the same masking
 * engine, the same placeholder resolution, the same result endpoint. Only the
 * way work arrives differs, so a group can be served by either.
 *
 * Still outbound only. The connection is dialled from inside the customer's
 * network; nothing has to reach this n8n.
 */

interface QueuedRequest {
	requestId: string;
	tool: string;
	request: {
		method: string;
		url: string;
		query?: Record<string, string>;
		headers?: Record<string, string>;
		body?: unknown;
	};
	masking: MaskingRule[];
	scope?: string;
	leaseUntil: number;
}

// API Gateway drops an idle connection after 10 minutes, so something has to
// travel before then. Well inside it, to survive a missed beat.
const PING_INTERVAL_MS = 4 * 60 * 1000;

// Reconnect backoff. Starts quick because most drops are momentary, and gives up
// climbing at a minute so a longer outage does not turn into a silent runner.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class LoopthinkRunnerWs implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink Runner (WebSocket)',
		name: 'loopthinkRunnerWs',
		// Its own copy rather than a ../ reference: n8n resolves node icons
		// relative to the node file and a parent hop is not something to rely on.
		icon: 'file:loopthink-mark.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=pushed',
		description: 'Executes loopthink MCP tool calls, pushed over a WebSocket instead of polled',
		defaults: { name: 'loopthink Runner (WebSocket)' },
		inputs: [],
		outputs: ['main'],
		credentials: [
			{ name: 'loopthinkRunnerApi', required: true, displayName: 'Authentication' },
			{ name: 'loopthinkTargetApi', required: false, displayName: 'Secrets' },
		],
		properties: [
			{
				displayName: 'Request Timeout (Seconds)',
				name: 'requestTimeout',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 120 },
				default: 30,
				description: 'How long to wait for the internal API before reporting the failure back to loopthink',
			},
			{
				displayName: 'Emit Results',
				name: 'emitResults',
				type: 'boolean',
				default: true,
				description:
					'Whether to emit each handled call into the workflow. Useful as an audit trail; the call is executed and answered either way.',
			},
			{
				displayName:
					'Work is pushed the moment it is queued, so there is no poll interval and no latency from one. Requires a Queue URL whose host speaks WebSocket. If your network only allows plain HTTPS, use the polling <b>loopthink Runner</b> node instead.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('loopthinkRunnerApi');
		const requestTimeout = (this.getNodeParameter('requestTimeout', 30) as number) * 1000;
		const emitResults = this.getNodeParameter('emitResults', true) as boolean;

		const queueUrl = String(credentials.queueUrl || '').replace(/\/+$/, '');
		const workspaceId = String(credentials.workspaceId || '');
		const groupId = String(credentials.groupId || '');
		const secret = String(credentials.secret || '');

		if (!queueUrl || !workspaceId || !groupId || !secret) {
			throw new NodeOperationError(this.getNode(), 'The loopthink Runner credential is incomplete', {
				description: 'Open the credential and fill in every field — the values are shown when the runner is created.',
			});
		}

		let secrets: Record<string, string> = {};
		try {
			secrets = secretsFromCredential(await this.getCredentials('loopthinkTargetApi'));
		} catch {
			// Not configured — a request carrying no placeholder still works.
		}

		const resultUrl = (requestId: string) =>
			`${queueUrl}/group/${workspaceId}/${groupId}/runner/request/${requestId}/result`;

		// Asked for rather than derived: the WebSocket API is its own host with its
		// own id, so swapping http for ws on the queue URL would dial nowhere. /ping
		// hands it over, which also keeps it out of the operator's credential.
		const ping = (await this.helpers.httpRequest({
			method: 'GET',
			url: `${queueUrl}/group/${workspaceId}/${groupId}/runner/ping`,
			headers: { Authorization: `Bearer ${secret}` },
			json: true,
		})) as { wsUrl?: string };

		if (!ping?.wsUrl) {
			throw new NodeOperationError(this.getNode(), 'This loopthink deployment has no WebSocket transport', {
				description: 'Use the polling "loopthink Runner" node instead, or ask for the transport to be enabled.',
			});
		}

		// Credentials go in the query string: $connect can read them there from any
		// client, whereas headers would tie the transport to one that can set them.
		const wsUrl =
			`${ping.wsUrl}` +
			`?workspaceId=${encodeURIComponent(workspaceId)}` +
			`&groupId=${encodeURIComponent(groupId)}` +
			`&secret=${encodeURIComponent(secret)}`;

		let socket: WebSocket | undefined;
		let pinger: NodeJS.Timeout | undefined;
		let reconnectTimer: NodeJS.Timeout | undefined;
		let backoff = RECONNECT_MIN_MS;
		let stopped = false;

		const report = async (requestId: string, result: IDataObject): Promise<void> => {
			await this.helpers.httpRequest({
				method: 'POST',
				url: resultUrl(requestId),
				headers: { Authorization: `Bearer ${secret}` },
				body: result,
				json: true,
			});
		};

		const execute = async (job: QueuedRequest): Promise<IDataObject> => {
			try {
				const resolved = substituteSecrets(job.request, secrets);

				// Assembled after substitution — encoding first would hide a
				// {{secret.NAME}} behind %7B%7B…%7D%7D and send it unresolved.
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
					timeout: requestTimeout,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
				});

				// Masked here, inside the network, before anything travels back.
				const masked = applyMasking(response.body, rulesForScope(job.masking || [], job.scope));
				return { status: response.statusCode, data: masked };
			} catch (error) {
				if (error instanceof MissingSecretError) {
					this.logger.warn(`loopthink Runner (WebSocket): ${error.message}`);
				}
				// Reported, not swallowed: the caller in the cloud is blocking on an
				// answer and would otherwise wait out its full timeout.
				return { error: (error as Error).message };
			}
		};

		const handle = async (job: QueuedRequest): Promise<void> => {
			const result = await execute(job);
			await report(job.requestId, result);

			if (emitResults) {
				this.emit([
					this.helpers.returnJsonArray([
						{
							requestId: job.requestId,
							tool: job.tool,
							method: job.request.method,
							// The queued form, placeholders unresolved: a substituted URL
							// can hold a secret, and n8n stores execution data.
							url: job.request.url,
							status: result.status ?? null,
							error: result.error ?? null,
							transport: 'websocket',
						},
					]),
				]);
			}
		};

		const connect = (): void => {
			if (stopped) return;

			socket = new WebSocket(wsUrl);

			socket.on('open', () => {
				// Only reset once a connection actually succeeded. Resetting on the
				// attempt would turn a refusing server into a tight retry loop.
				backoff = RECONNECT_MIN_MS;
				this.logger.info('loopthink Runner (WebSocket): connected');
				pinger = setInterval(() => {
					if (socket?.readyState === WebSocket.OPEN) {
						socket.send(JSON.stringify({ type: 'ping' }));
					}
				}, PING_INTERVAL_MS);
			});

			socket.on('message', (raw) => {
				let message: any;
				try {
					message = JSON.parse(raw.toString());
				} catch {
					return; // not ours
				}
				if (message?.type !== 'request' || !message.request) return;

				void handle(message.request as QueuedRequest).catch((e) =>
					this.logger.warn(`loopthink Runner (WebSocket): ${(e as Error).message}`),
				);
			});

			const scheduleReconnect = () => {
				if (pinger) clearInterval(pinger);
				if (stopped) return;
				reconnectTimer = setTimeout(connect, backoff);
				backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
			};

			// API Gateway closes every connection after two hours regardless, so a
			// close is normal operation rather than a fault to report.
			socket.on('close', scheduleReconnect);
			socket.on('error', (e) => {
				this.logger.warn(`loopthink Runner (WebSocket): ${(e as Error).message}`);
				socket?.close();
			});
		};

		connect();

		return {
			closeFunction: async () => {
				stopped = true;
				if (pinger) clearInterval(pinger);
				if (reconnectTimer) clearTimeout(reconnectTimer);
				socket?.close();
			},
		};
	}
}
