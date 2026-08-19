import type {
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { startSocket } from './socket';
import { emitJob, RUNNER_OUTPUTS, type QueuedRequest } from './workflowTools';

/**
 * loopthink Runner — executes MCP tool calls inside your own network.
 *
 * This is a trigger node rather than an action node for one structural reason:
 * `trigger()` is invoked once when the workflow is activated and stays alive, so
 * the polling loop lives in the n8n process rather than in workflow executions.
 * A Schedule trigger at the same interval would create ~2.6M executions a month,
 * over 99% of them finding nothing to do. Here an execution exists only when
 * there is actually a tool call to run.
 *
 * The connection is outbound only. Nothing needs to reach this n8n from the
 * internet, which is the entire reason this node exists instead of the Docker
 * runner.
 *
 * It claims work and emits it. It does not execute anything: an HTTP tool goes
 * to a branch ending in loopthink's Execute Request, a workflow tool to a branch
 * that answers it. Both then answer through Send Result. Executing inside the
 * trigger meant one output said "already answered" and another said "still needs
 * answering", a distinction every workflow had to know about, and it put the
 * credentials for the customer's own APIs on a node that mostly does not call
 * them.
 */

export class LoopthinkRunner implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink Runner',
		name: 'loopthinkRunner',
		// SVG, not the PNG: n8n rendered the SVG here and not the PNG, so the mark
		// is wrapped in one rather than fighting the icon route.
		// Distinct filename on purpose: the icon URL is the cache key, so reusing
		// loopthink.svg served the browser's copy of an older mark forever.
		icon: 'file:loopthink-mark.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["transport"] === "websocket" ? "pushed" : $parameter["pollInterval"] + "s poll"}}',
		description: 'Claims loopthink MCP tool calls and executes the HTTP ones inside your network',
		defaults: { name: 'loopthink Runner' },
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node -- a
		// trigger takes no input; the rule only recognises that on a class named
		// *Trigger, and renaming this one would rename the node type and break
		// every workflow that already uses it.
		inputs: ['main'],
		// n8n-workflow 2.x exposes NodeConnectionType as a type, not an enum value,
		// so the literal is the portable form here.
		outputs: RUNNER_OUTPUTS,
		credentials: [
			{ name: 'loopthinkRunnerApi', required: true, displayName: 'Authentication' },
		],
		properties: [
			{
				// One node, because which transport a network allows is not something
				// a customer should have to answer by picking a different node — and
				// everything downstream of it is identical either way.
				displayName: 'Transport',
				name: 'transport',
				type: 'options',
				noDataExpression: true,
				default: 'polling',
				options: [
					{
						name: 'Polling',
						value: 'polling',
						description: 'Asks for work over plain HTTPS. Works through any proxy.',
					},
					{
						name: 'WebSocket',
						value: 'websocket',
						description:
							'Holds one outbound connection and is pushed work the moment it is queued. No poll latency, far cheaper, but the network has to allow WebSocket upgrades.',
					},
				],
			},
			{
				displayName: 'Poll Interval (Seconds)',
				displayOptions: { show: { transport: ['polling'] } },
				name: 'pollInterval',
				type: 'number',
				typeOptions: { minValue: 10, maxValue: 300 },
				default: 10,
				description:
					'How often to check for work. This is the latency added to every tool call, and every poll is a request you pay for. Ten seconds is the floor; use WebSocket if the wait matters, because a pushed call has none of it.',
			},
			{
				// A notice renders its displayName — `default` is not shown at all,
				// which is easy to get backwards and leaves an empty box behind.
				displayName:
					'Every claimed call leaves here. Route it with a Switch on <code>{{$json.tool}}</code>: a workflow tool goes to the branch that answers it, an HTTP tool to a branch with <b>loopthink → Execute Request</b>. Every branch ends in <b>loopthink → Send Result</b>. Give the Switch a fallback, or a tool nobody answers leaves the caller waiting out its timeout.',
				name: 'workflowNotice',
				type: 'notice',
				default: '',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('loopthinkRunnerApi');
		// Clamped rather than trusted: an interval saved before the floor existed,
		// or typed past the field, would otherwise poll as fast as it liked.
		const pollInterval = Math.max(10, this.getNodeParameter('pollInterval', 10) as number) * 1000;
		const transport = this.getNodeParameter('transport', 'polling') as 'polling' | 'websocket';

		const queueUrl = String(credentials.queueUrl || '').replace(/\/+$/, '');
		const workspaceId = String(credentials.workspaceId);
		const groupId = String(credentials.groupId);
		const secret = String(credentials.secret);
		// Say so loudly. A blank field here used to build a nonsense URL and poll it
		// forever: the workflow looked healthy, the runner just never showed up in
		// loopthink and nothing said why.
		for (const [label, value] of [
			['Queue URL', queueUrl],
			['Workspace ID', workspaceId],
			['Group ID', groupId],
			['Secret', secret],
		] as const) {
			if (!value) {
				throw new NodeOperationError(
					this.getNode(),
					`${label} is missing from the loopthink Runner credential`,
					{ description: 'Open the credential and fill it in. The values are shown when the runner is created in loopthink.' },
				);
			}
		}

		const base = `${queueUrl}/group/${workspaceId}/${groupId}/runner`;

		let stopped = false;
		let timer: NodeJS.Timeout | undefined;

		const claim = async (): Promise<QueuedRequest | null> => {
			const response = await this.helpers.httpRequest({
				method: 'POST',
				url: `${base}/next`,
				headers: { Authorization: `Bearer ${secret}` },
				json: true,
				// 204 is the overwhelmingly common answer; treat it as data, not failure.
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});
			if (response.statusCode === 204) return null;
			if (response.statusCode !== 200) {
				throw new NodeApiError(this.getNode(), response.body as JsonObject, {
					message: `loopthink returned ${response.statusCode} when claiming work`,
					description:
						'Check the runner secret and the queue URL on the credential. A 401 means the secret was revoked or belongs to another server.',
					httpCode: String(response.statusCode),
				});
			}
			return response.body as QueuedRequest;
		};

		// One shape for both transports: claimed work goes out, nothing is run here.
		const handle = async (job: QueuedRequest): Promise<void> => {
			emitJob(this, job);
		};

		if (transport === 'websocket') {
			const socket = await startSocket(this, { queueUrl, workspaceId, groupId, secret, handle });
			return { closeFunction: async () => socket.close() };
		}

		const tick = async (): Promise<void> => {
			if (stopped) return;
			try {
				const job = await claim();
				if (job) {
					await handle(job);

					// Work tends to arrive in bursts — go straight back for more
					// instead of sleeping out the interval between two calls.
					if (!stopped) {
						setImmediate(() => void tick());
						return;
					}
				}
			} catch (error) {
				// Keep polling through transient failures. Stopping on a blip would
				// leave the runner silently dead until someone reactivates it.
				this.logger.warn(`loopthink Runner: ${(error as Error).message}`);
			}
			if (!stopped) {
				timer = setTimeout(() => void tick(), pollInterval);
			}
		};

		void tick();

		return {
			closeFunction: async () => {
				stopped = true;
				if (timer) clearTimeout(timer);
			},
			// Manual "Test workflow" runs: one pass, so the editor shows something
			// without leaving a loop running behind the tab.
			manualTriggerFunction: async () => {
				await tick();
			},
		};
	}
}
