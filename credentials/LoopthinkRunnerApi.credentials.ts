import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class LoopthinkRunnerApi implements ICredentialType {
	name = 'loopthinkRunnerApi';

	displayName = 'loopthink Runner API';

	documentationUrl = 'https://www.loopthink.ai';

	properties: INodeProperties[] = [
		{
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			default: 'https://mcp.eu.loopthink.ai',
			description: 'Base URL of the loopthink MCP service. Shown together with the secret when you create the runner.',
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
				'Shown once when the runner is created in loopthink and never again. Lost it? Issue a new one there — the old one keeps working for 24 hours.',
		},
	];
}
