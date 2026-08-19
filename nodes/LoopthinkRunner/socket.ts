import type { ITriggerFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import WebSocket from 'ws';

import type { QueuedRequest } from './workflowTools';

/**
 * The WebSocket transport: the same queue, told instead of asked.
 *
 * Only how work arrives lives here. What happens to a claimed call — the
 * secrets, the masking, the result endpoint, which output a workflow tool leaves
 * on — is passed in, because it is identical either way. As two separate nodes
 * every change had to be made twice and stayed right only by luck.
 */

// Two deadlines, and the shorter one wins. API Gateway drops an idle connection
// after 10 minutes; the runner's own heartbeat in loopthink expires after 90
// seconds, and on this transport a ping is the only thing that refreshes it.
// Pinging every four minutes kept the socket alive and let the runner read as
// offline in between.
const PING_INTERVAL_MS = 60 * 1000;

// Reconnect backoff. Starts quick because most drops are momentary, and stops
// climbing at a minute so a longer outage does not turn into a silent runner.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export interface SocketOptions {
	queueUrl: string;
	workspaceId: string;
	groupId: string;
	secret: string;
	handle: (job: QueuedRequest) => Promise<void>;
}

export interface SocketTransport {
	close: () => void;
}

export async function startSocket(
	ctx: ITriggerFunctions,
	{ queueUrl, workspaceId, groupId, secret, handle }: SocketOptions,
): Promise<SocketTransport> {
	// Asked for rather than derived: the WebSocket API is its own host with its
	// own id, so swapping http for ws on the queue URL would dial nowhere. /ping
	// hands it over, which also keeps it out of the operator's credential.
	const ping = (await ctx.helpers.httpRequest({
		method: 'GET',
		url: `${queueUrl}/group/${workspaceId}/${groupId}/runner/ping`,
		headers: { Authorization: `Bearer ${secret}` },
		json: true,
	})) as { wsUrl?: string };

	if (!ping?.wsUrl) {
		throw new NodeOperationError(ctx.getNode(), 'This loopthink deployment has no WebSocket transport', {
			description: 'Switch Transport to Polling, or ask for the transport to be enabled.',
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
	// Whether a socket was ever established. A network that blocks WebSocket
	// upgrades looks exactly like one that is briefly down — except it never
	// recovers, and the only visible symptom is a runner that stays offline.
	let everConnected = false;
	let failedAttempts = 0;

	const connect = (): void => {
		if (stopped) return;

		socket = new WebSocket(wsUrl);

		socket.on('open', () => {
			// Only reset once a connection actually succeeded. Resetting on the
			// attempt would turn a refusing server into a tight retry loop.
			backoff = RECONNECT_MIN_MS;
			everConnected = true;
			failedAttempts = 0;
			ctx.logger.info('loopthink Runner: WebSocket connected');
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
				ctx.logger.warn(`loopthink Runner: ${(e as Error).message}`),
			);
		});

		const scheduleReconnect = () => {
			if (pinger) clearInterval(pinger);
			if (stopped) return;

			// Say it plainly, once. Repeated failures with no connection ever
			// established are almost always a proxy refusing the upgrade — and
			// without this the only symptom is a runner that never appears in
			// loopthink, with nothing anywhere explaining why.
			failedAttempts += 1;
			if (!everConnected && failedAttempts === 3) {
				ctx.logger.error(
					'loopthink Runner: could not establish a WebSocket connection after three attempts. ' +
						'This network most likely does not allow WebSocket upgrades (a proxy, or TLS inspection breaking them). ' +
						'Switch Transport to Polling. It needs nothing but plain HTTPS.',
				);
			}
			reconnectTimer = setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
		};

		// API Gateway closes every connection after two hours regardless, so a
		// close is normal operation rather than a fault to report.
		socket.on('close', scheduleReconnect);
		socket.on('error', (e) => {
			ctx.logger.warn(`loopthink Runner: ${(e as Error).message}`);
			socket?.close();
		});
	};

	connect();

	return {
		close: () => {
			stopped = true;
			if (pinger) clearInterval(pinger);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.close();
		},
	};
}
