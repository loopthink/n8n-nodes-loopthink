import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Authentication for the internal API the runner calls.
 *
 * Kept separate from the runner credential, and kept here rather than in
 * loopthink, on purpose: the whole point of a self-hosted runner is that the
 * credentials for your own systems never leave your network. loopthink sends the
 * request to make — method, URL, masking rules — but never the key to make it with.
 */
export class LoopthinkTargetApi implements ICredentialType {
	name = 'loopthinkTargetApi';

	displayName = 'loopthink Target API (internal system)';

	documentationUrl = 'https://www.loopthink.ai';

	properties: INodeProperties[] = [
		{
			displayName: 'Authentication',
			name: 'authType',
			type: 'options',
			options: [
				{ name: 'None', value: 'none' },
				{ name: 'Bearer Token', value: 'bearer' },
				{ name: 'Header', value: 'header' },
			],
			default: 'none',
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authType: ['bearer'] } },
		},
		{
			displayName: 'Header Name',
			name: 'headerName',
			type: 'string',
			default: 'X-API-Key',
			displayOptions: { show: { authType: ['header'] } },
		},
		{
			displayName: 'Header Value',
			name: 'headerValue',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authType: ['header'] } },
		},
	];
}
