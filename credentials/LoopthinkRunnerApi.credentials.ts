import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class LoopthinkRunnerApi implements ICredentialType {
	name = 'loopthinkRunnerApi';

	displayName = 'Loopthink Runner API';

	// Two rules disagree here: one wants a camelCase slug, which n8n resolves
	// against its own docs, the other wants a URL. A community node has no page
	// in those docs, so the URL is the one that leads anywhere.
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
	documentationUrl = 'https://www.loopthink.ai/docs/n8n';

	properties: INodeProperties[] = [
		{
			// Not "API URL": whoever holds the queue is what matters, and that is not
			// always the loopthink platform. In a two-runner setup a gateway runner in
			// your own network holds it, and the platform is not involved at all.
			displayName: 'Queue URL',
			name: 'queueUrl',
			type: 'string',
			default: 'https://api.eu.loopthink.ai/mcp',
			description:
				'The service holding the work queue: the loopthink platform, or a gateway runner inside your own network. Shown together with the secret when the runner is created.',
		},
		{
			displayName: 'Workspace ID',
			name: 'workspaceId',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Group ID',
			name: 'groupId',
			type: 'string',
			default: '',
			required: true,
			description: 'The MCP server (group) this runner executes tools for',
		},
		{
			// Not a password in the usual sense — it is the runner's whole identity.
			// Workspace and group id are public identifiers that make the lookup cheap;
			// this is the only value that grants access.
			displayName: 'Secret',
			name: 'secret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Shown once when the runner is created and never again. Lost it? Issue a new one there; the old one keeps working for 24 hours.',
		},
	];

	// Deliberately /ping and not /next: claiming from the queue is what /next does,
	// so a connection test pointed at it would swallow a real tool call. /ping only
	// checks the credentials, and does not count as a heartbeat either — saving a
	// credential should not make the runner look online in loopthink.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.queueUrl}}',
			url: '=/group/{{$credentials.workspaceId}}/{{$credentials.groupId}}/runner/ping',
			method: 'GET',
			headers: { Authorization: '=Bearer {{$credentials.secret}}' },
		},
	};
}
