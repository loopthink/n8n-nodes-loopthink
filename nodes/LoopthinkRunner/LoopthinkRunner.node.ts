import type {
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { startSocket } from './socket';
import { emitJob, RUNNER_OUTPUTS, type QueuedRequest } from './workflowTools';

/**
 * loopthink Runner — executes MCP tool calls inside your own network.
 *
 * This is a trigger node rather than an action node for one structural reason:
 * `trigger()` is invoked once when the workflow is activated and stays alive, so
 * the connection to loopthink lives in the n8n process rather than in workflow
 * executions. An execution exists only when there is actually a tool call to
 * run.
 *
 * Work arrives pushed over one outbound WebSocket. Nothing needs to reach this
 * n8n from the internet, which is the entire reason this node exists instead of
 * the Docker runner.
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
				// A notice renders its displayName — `default` is not shown at all,
				// which is easy to get backwards and leaves an empty box behind.
				displayName:
					'Every claimed call leaves here. Route it with a Switch on <code>{{$json.tool}}</code>: a workflow tool goes to the branch that answers it, an HTTP tool to a branch with <b>loopthink → Execute Request</b>. Every branch ends in <b>loopthink → Send Result</b>. Give the Switch a fallback, or a tool nobody answers leaves the caller waiting out its timeout.<br><br>For a server that proxies an MCP server in this network, no Switch: connect <b>loopthink → Call MCP Server</b> directly. It forwards every call and answers it.',
				name: 'workflowNotice',
				type: 'notice',
				default: '',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('loopthinkRunnerApi');

		const queueUrl = String(credentials.queueUrl || '').replace(/\/+$/, '');
		const workspaceId = String(credentials.workspaceId);
		const groupId = String(credentials.groupId);
		const secret = String(credentials.secret);
		// Say so loudly. A blank field here used to build a nonsense URL and dial
		// it forever: the workflow looked healthy, the runner just never showed up
		// in loopthink and nothing said why.
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

		// Claimed work goes out, nothing is run here.
		const handle = async (job: QueuedRequest): Promise<void> => {
			emitJob(this, job);
		};

		const socket = await startSocket(this, { queueUrl, workspaceId, groupId, secret, handle });
		return { closeFunction: async () => socket.close() };
	}
}
