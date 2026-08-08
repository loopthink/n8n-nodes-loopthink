import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';

import { applyMasking, rulesForScope, type MaskingRule } from './masking';
import { MissingSecretError, secretsFromCredential, substituteSecrets } from './secrets';

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
 */

interface QueuedRequest {
	requestId: string;
	tool: string;
	request: {
		method: string;
		url: string;
		headers?: Record<string, string>;
		body?: unknown;
	};
	masking: MaskingRule[];
	scope?: string;
	credentialRef?: string;
	leaseUntil: number;
}

export class LoopthinkRunner implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'loopthink Runner',
		name: 'loopthinkRunner',
		icon: 'file:loopthink.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["pollInterval"] + "s poll"}}',
		description: 'Executes loopthink MCP tool calls against internal HTTP APIs',
		defaults: { name: 'loopthink Runner' },
		inputs: [],
		// n8n-workflow 2.x exposes NodeConnectionType as a type, not an enum value,
		// so the literal is the portable form here.
		outputs: ['main'],
		credentials: [
			{ name: 'loopthinkRunnerApi', required: true },
			{ name: 'loopthinkTargetApi', required: false },
		],
		properties: [
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 60 },
				default: 2,
				description:
					'How often to check for work. This is the latency added to every tool call, so lower is snappier — and every poll is a request you pay for. 1–5s is the sensible range.',
			},
			{
				displayName: 'Request Timeout (Seconds)',
				name: 'requestTimeout',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 120 },
				default: 30,
				description:
					'How long to wait for the internal API before giving up and reporting the failure back to loopthink',
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
				displayName: 'Notice',
				name: 'notice',
				type: 'notice',
				default:
					'Results are masked here, inside your network, before they travel back. Credentials for your internal APIs stay in this n8n — loopthink sends the request to make, never the key to make it with.',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('loopthinkRunnerApi');
		const pollInterval = (this.getNodeParameter('pollInterval', 2) as number) * 1000;
		const requestTimeout = (this.getNodeParameter('requestTimeout', 30) as number) * 1000;
		const emitResults = this.getNodeParameter('emitResults', true) as boolean;

		const apiUrl = String(credentials.apiUrl || '').replace(/\/+$/, '');
		const workspaceId = String(credentials.workspaceId);
		const groupId = String(credentials.groupId);
		const secret = String(credentials.secret);
		const base = `${apiUrl}/group/${workspaceId}/${groupId}/runner`;

		// Optional: a group may point at an API that needs no secret at all.
		let secrets: Record<string, string> = {};
		try {
			secrets = secretsFromCredential(await this.getCredentials('loopthinkTargetApi'));
		} catch {
			// Not configured — a request carrying no placeholder still works.
		}

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
				throw new Error(
					`loopthink returned ${response.statusCode} when claiming work: ${JSON.stringify(response.body)}`,
				);
			}
			return response.body as QueuedRequest;
		};

		const report = async (requestId: string, result: IDataObject): Promise<void> => {
			await this.helpers.httpRequest({
				method: 'POST',
				url: `${base}/request/${requestId}/result`,
				headers: { Authorization: `Bearer ${secret}` },
				body: result,
				json: true,
			});
		};

		const execute = async (job: QueuedRequest): Promise<IDataObject> => {
			try {
				// Placeholders are filled in here and nowhere else. `resolved` must
				// never be logged or emitted — it holds the actual secrets.
				const resolved = substituteSecrets(job.request, secrets);

				const response = await this.helpers.httpRequest({
					method: (resolved.method || 'GET') as any,
					url: resolved.url,
					headers: resolved.headers || {},
					body: resolved.body ?? undefined,
					json: true,
					timeout: requestTimeout,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
				});

				// Masking happens here, before anything leaves this network. An
				// unmasked payload must never be what travels back.
				const masked = applyMasking(response.body, rulesForScope(job.masking || [], job.scope));
				return { status: response.statusCode, data: masked };
			} catch (error) {
				// A missing secret is an operator problem, not a transient one — the
				// message names which, so it can be fixed without guesswork.
				if (error instanceof MissingSecretError) {
					this.logger.warn(`loopthink Runner: ${error.message}`);
				}
				// Report the failure rather than swallowing it: the caller in the
				// cloud is blocking on an answer and would otherwise wait out the
				// full timeout for something that already failed.
				return { error: (error as Error).message };
			}
		};

		const tick = async (): Promise<void> => {
			if (stopped) return;
			try {
				const job = await claim();
				if (job) {
					const result = await execute(job);
					await report(job.requestId, result);

					if (emitResults) {
						this.emit([
							this.helpers.returnJsonArray([
								{
									requestId: job.requestId,
									tool: job.tool,
									method: job.request.method,
									// The queued form, with placeholders unresolved — the
									// substituted URL can hold a secret, and this lands in
									// n8n's execution records.
									url: job.request.url,
									status: result.status ?? null,
									error: result.error ?? null,
									maskingRules: (job.masking || []).length,
								},
							]),
						]);
					}

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
