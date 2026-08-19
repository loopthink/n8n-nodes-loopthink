import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Secrets for the internal systems this runner calls.
 *
 * These stay here, in your n8n, and are never sent to loopthink. In loopthink you
 * configure the *shape* of a request, which header and which path, and write
 * `{{secret.NAME}}` where a value belongs. The runner fills those in on the way
 * out. loopthink sends the request to make, never the key to make it with.
 *
 * The base URL belongs here for the same reason. It names a host inside this
 * network, so a server whose tools are answered from here does not hand it to
 * loopthink at all: the request arrives as a path and is resolved against this.
 *
 * A name/value list rather than one JSON field: n8n gives it a real form, and a
 * missing comma cannot take down every call at once.
 */
export class LoopthinkTargetApi implements ICredentialType {
	name = 'loopthinkTargetApi';

	displayName = 'Loopthink Target Secrets API';

	// Two rules disagree here: one wants a camelCase slug, which n8n resolves
	// against its own docs, the other wants a URL. A community node has no page
	// in those docs, so the URL is the one that leads anywhere.
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
	documentationUrl = 'https://www.loopthink.ai/docs/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'http://pms.internal:8080',
			description:
				'Where the tool paths point. An n8n server does not tell loopthink this, because the host is reachable from here and from nowhere else, so it arrives as a path and is joined with this. Needed only if the server has HTTP tools.',
		},
		{
			displayName: 'Secrets',
			name: 'secrets',
			placeholder: 'Add secret',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			description:
				'Each entry matches a {{secret.NAME}} placeholder configured in loopthink. A call whose placeholder is missing here is refused rather than sent, because an unresolved placeholder would reach the target system and end up in its logs.',
			options: [
				{
					name: 'secret',
					displayName: 'Secret',
					values: [
						{
							displayName: 'Name',
							name: 'name',
							type: 'string',
							default: '',
							placeholder: 'CRM_API_KEY',
							description: 'The NAME in {{secret.NAME}}, exactly as written in loopthink',
						},
						{
							displayName: 'Value',
							name: 'value',
							type: 'string',
							typeOptions: { password: true },
							default: '',
						},
					],
				},
			],
		},
	];
}
