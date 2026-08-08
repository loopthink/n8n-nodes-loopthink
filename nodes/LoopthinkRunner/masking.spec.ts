import { expect } from 'chai';
import { applyMasking, rulesForScope, type MaskingRule } from './masking';

// These rules arrive from loopthink with each request — the engine is what lives
// here. The cases below are the ones that decide whether a value leaves this
// network in the clear, so they are worth pinning down rather than trusting.

describe('Masking', () => {
	it('masks a named field and drops a removed one', () => {
		const rules: MaskingRule[] = [
			{ field: 'email', strategy: 'mask' },
			{ field: 'ssn', strategy: 'remove' },
		];

		expect(applyMasking({ id: 7, email: 'ada@example.com', ssn: '123' }, rules)).to.deep.equal({
			id: 7,
			email: 'a*************m',
		});
	});

	it('gives the same input the same pseudonym', () => {
		const rules: MaskingRule[] = [{ field: 'customer', strategy: 'pseudonymize' }];
		const out: any = applyMasking({ a: { customer: 'ACME' }, b: { customer: 'ACME' } }, rules);

		expect(out.a.customer).to.equal(out.b.customer);
		expect(out.a.customer).to.not.equal('ACME');
	});

	it('finds patterns inside free text', () => {
		const out: any = applyMasking({ note: 'Reach ada@example.com about DE89370400440532013000' }, [
			{ pattern: 'email', strategy: 'mask' },
			{ pattern: 'iban', strategy: 'remove' },
		]);

		expect(out.note).to.not.contain('ada@example.com');
		expect(out.note).to.not.contain('DE89370400440532013000');
	});

	it('reaches through arrays and nesting', () => {
		const out: any = applyMasking(
			{ rows: [{ email: 'a@b.de' }, { nested: { email: 'c@d.de' } }] },
			[{ field: 'email', strategy: 'mask' }],
		);

		expect(out.rows[0].email).to.not.contain('@');
		expect(out.rows[1].nested.email).to.not.contain('@');
	});

	it('leaves null alone instead of masking the word "null"', () => {
		// Stringifying first would return "n**l" and invent a value where the
		// source had none — the model would read it as data.
		expect(applyMasking({ email: null }, [{ field: 'email', strategy: 'mask' }])).to.deep.equal({
			email: null,
		});
	});

	it('does not fire a scoped rule when the target is unknown', () => {
		// HTTP tools rarely carry a scope. A rule that silently does nothing is
		// worse than one that errors, so this is the behaviour to be sure of.
		const rules: MaskingRule[] = [{ field: 'email', strategy: 'mask', scope: 'contacts' }];

		expect(rulesForScope(rules, undefined)).to.have.lengthOf(0);
		expect(rulesForScope(rules, 'contacts')).to.have.lengthOf(1);
		expect(rulesForScope(rules, 'companies')).to.have.lengthOf(0);
	});

	it('returns the payload untouched when there are no rules', () => {
		const data = { email: 'ada@example.com' };

		expect(applyMasking(data, [])).to.deep.equal(data);
	});
});
