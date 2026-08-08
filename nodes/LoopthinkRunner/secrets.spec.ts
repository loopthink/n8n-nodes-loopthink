import { expect } from 'chai';
import {
	MissingSecretError,
	collectPlaceholders,
	secretsFromCredential,
	substituteSecrets,
} from './secrets';

const SECRETS = { CRM_API_KEY: 'sk-live-123', TENANT: 'acme' };

describe('Secret placeholders', () => {
	it('fills a placeholder in a header value', () => {
		const out = substituteSecrets(
			{ method: 'GET', url: 'https://crm.internal/v1', headers: { 'X-API-Key': '{{secret.CRM_API_KEY}}' } },
			SECRETS,
		);

		expect(out.headers['X-API-Key']).to.equal('sk-live-123');
	});

	it('fills placeholders in the URL and in a nested body', () => {
		const out = substituteSecrets(
			{
				url: 'https://api.internal/{{secret.TENANT}}/orders?key={{secret.CRM_API_KEY}}',
				body: { auth: { token: '{{secret.CRM_API_KEY}}' }, list: ['{{secret.TENANT}}'] },
			},
			SECRETS,
		);

		expect(out.url).to.equal('https://api.internal/acme/orders?key=sk-live-123');
		expect((out.body as any).auth.token).to.equal('sk-live-123');
		expect((out.body as any).list[0]).to.equal('acme');
	});

	it('refuses the whole request when a secret is missing', () => {
		// Fail closed. Sending the literal placeholder would earn a 401 and leave
		// "{{secret.NOPE}}" in the target's access log for someone to puzzle over.
		expect(() => substituteSecrets({ headers: { A: '{{secret.NOPE}}' } }, SECRETS)).to.throw(
			MissingSecretError,
		);

		try {
			substituteSecrets({ a: '{{secret.NOPE}}', b: '{{secret.ALSO_NOPE}}' }, SECRETS);
			expect.fail('should have thrown');
		} catch (e) {
			// Names both, so one round of fixing is enough.
			expect((e as Error).message).to.contain('NOPE');
			expect((e as Error).message).to.contain('ALSO_NOPE');
		}
	});

	it('treats a blank value as missing rather than sending an empty header', () => {
		const creds = secretsFromCredential({
			secrets: { secret: [{ name: 'CRM_API_KEY', value: '' }, { name: '  ', value: 'x' }] },
		});

		expect(creds).to.deep.equal({});
		expect(() => substituteSecrets({ a: '{{secret.CRM_API_KEY}}' }, creds)).to.throw(MissingSecretError);
	});

	it('leaves a payload without placeholders untouched', () => {
		const request = { url: 'https://api.internal/v1', headers: { Accept: 'application/json' } };

		expect(substituteSecrets(request, {})).to.deep.equal(request);
	});

	it('tolerates whitespace inside the braces', () => {
		expect(collectPlaceholders('{{ secret.TENANT }}')).to.deep.equal(new Set(['TENANT']));
		expect(substituteSecrets({ a: '{{ secret.TENANT }}' }, SECRETS).a).to.equal('acme');
	});

	it('reads the credential list into a lookup', () => {
		expect(
			secretsFromCredential({ secrets: { secret: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] } }),
		).to.deep.equal({ A: '1', B: '2' });
		expect(secretsFromCredential(undefined)).to.deep.equal({});
	});
});
