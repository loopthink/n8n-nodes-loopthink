import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Secrets for the internal systems this runner calls.
 *
 * These stay here, in your n8n, and are never sent to loopthink. In loopthink you
 * configure the *shape* of a request — which header, which URL — and write
 * `{{secret.NAME}}` where the value belongs. The runner fills those in on the way
 * out. loopthink sends the request to make, never the key to make it with.
 *
 * A name/value list rather than one JSON field: n8n gives it a real form, and a
 * missing comma cannot take down every call at once.
 */
export class LoopthinkTargetApi implements ICredentialType {
	name = 'loopthinkTargetApi';

	displayName = 'loopthink Target Secrets';

	documentationUrl = 'https://www.loopthink.ai';

	properties: INodeProperties[] = [
		{
			displayName: 'Secrets',
			name: 'secrets',
			placeholder: 'Add secret',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			description:
				'Each entry matches a {{secret.NAME}} placeholder configured in loopthink. A call whose placeholder is missing here is refused rather than sent — an unresolved placeholder would otherwise reach the target system and end up in its logs.',
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
