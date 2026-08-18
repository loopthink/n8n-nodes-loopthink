import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { applyMasking, rulesForScope } from './masking';
import { MissingSecretError, secretsFromCredential, substituteSecrets } from './secrets';
import {
	configuredOutputs,
	handOverToBranch,
	emitOn,
	isParamsRequest,
	outputCount,
	toolList,
	workflowToolsProperty,
	type HttpPayload,
	type QueuedRequest,
} from './workflowTools';

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
		subtitle: '={{$parameter["pollInterval"] + "s poll"}}',
		description: 'Executes loopthink MCP tool calls against internal HTTP APIs',
		defaults: { name: 'loopthink Runner' },
		inputs: [],
		// n8n-workflow 2.x exposes NodeConnectionType as a type, not an enum value,
		// so the literal is the portable form here.
		outputs: `={{(${configuredOutputs})($parameter)}}`,
		credentials: [
			// Both slots render as a bare "Credential" without these — which tells
			// nobody which one is which.
			{ name: 'loopthinkRunnerApi', required: true, displayName: 'Authentication' },
			{ name: 'loopthinkTargetApi', required: false, displayName: 'Secrets' },
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
			workflowToolsProperty,
			{
				// A notice renders its displayName — `default` is not shown at all, which
				// is easy to get backwards and leaves an empty box behind.
				displayName:
					'Results are masked here, inside your network, before they travel back. Keys for your internal APIs stay in this n8n: write <code>{{secret.NAME}}</code> in loopthink where a value belongs, and add a matching entry under <b>Secrets</b>. A call whose placeholder has no entry is refused rather than sent.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('loopthinkRunnerApi');
		const pollInterval = (this.getNodeParameter('pollInterval', 2) as number) * 1000;
		const requestTimeout = (this.getNodeParameter('requestTimeout', 30) as number) * 1000;
		const emitResults = this.getNodeParameter('emitResults', true) as boolean;
		const workflowTools = toolList(this.getNodeParameter('workflowTools', ''));

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
					{ description: 'Open the credential and fill it in — the values are shown when the runner is created in loopthink.' },
				);
			}
		}

		const base = `${queueUrl}/group/${workspaceId}/${groupId}/runner`;

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

		const execute = async (job: QueuedRequest, request: HttpPayload): Promise<IDataObject> => {
			try {
				// Placeholders are filled in here and nowhere else. `resolved` must
				// never be logged or emitted — it holds the actual secrets.
				const resolved = substituteSecrets(request, secrets);

				// Assembled here, after substitution: encoding a {{secret.NAME}}
				// placeholder first would hide it behind %7B%7B…%7D%7D, and it would
				// travel to the target unresolved and unreported.
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
					if (isParamsRequest(job.request)) {
						await handOverToBranch(this, workflowTools, job, job.request, report);
					} else {
						const request = job.request;
						const result = await execute(job, request);
						await report(job.requestId, result);

						if (emitResults) {
							emitOn(this, outputCount(workflowTools), 0, {
								requestId: job.requestId,
								tool: job.tool,
								method: request.method,
								// The queued form, with placeholders unresolved — the
								// substituted URL can hold a secret, and this lands in
								// n8n's execution records.
								url: request.url,
								status: result.status ?? null,
								error: result.error ?? null,
								maskingRules: (job.masking || []).length,
							});
						}
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
