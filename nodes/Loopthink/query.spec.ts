import { expect } from 'chai';

import {
	DATE_MAX,
	DATE_MIN,
	NUMBER_MIN,
	likeValue,
	prepareQuery,
	sortDirection,
} from './query';

// A Data Table condition row exists whether or not the call filled it. These
// cases are what keeps an unfilled row from excluding everything.

const BASE = { defaultLimit: 20, order: 'DESC' as const };
const CREATED = { column: 'createdAt', parameter: 'created', type: 'date' as const };

describe('prepareQuery', () => {
	it('gives every key a plain value, with nothing nested', () => {
		const q = prepareQuery({}, { ...BASE, ranges: [CREATED], matches: [{ column: 'status' }] });
		for (const key of ['createdAt_min', 'createdAt_max', 'status']) {
			expect(q[key], key).to.not.be.an('object');
		}
	});

	it('opens a range all the way up when the call sent neither bound', () => {
		const q = prepareQuery({}, { ...BASE, ranges: [CREATED] });
		expect(q.createdAt_min).to.equal(DATE_MIN);
		expect(q.createdAt_max).to.equal(DATE_MAX);
	});

	it('takes the bound that was sent and opens only the other side', () => {
		const q = prepareQuery({ created_after: '2026-01-01' }, { ...BASE, ranges: [CREATED] });
		expect(q.createdAt_min).to.equal('2026-01-01');
		expect(q.createdAt_max).to.equal(DATE_MAX);
	});

	it('accepts any of the suffixes a tool might use for the same bound', () => {
		const ranges = [{ column: 'total_amount', type: 'number' as const }];
		expect(prepareQuery({ total_amount_min: 50 }, { ...BASE, ranges }).total_amount_min).to.equal(50);
		expect(prepareQuery({ total_amount_from: 50 }, { ...BASE, ranges }).total_amount_min).to.equal(50);
	});

	it('treats a range on id like any other, which is how a model reads on', () => {
		// The whole of what used to be the cursor. No key of its own, no protocol.
		const ranges = [{ column: 'id', type: 'number' as const }];
		expect(prepareQuery({}, { ...BASE, ranges }).id_min).to.equal(NUMBER_MIN);
		expect(prepareQuery({ id_after: 8 }, { ...BASE, ranges }).id_min).to.equal(8);
	});

	it('asks for one row more than it answers with', () => {
		// That extra row is the only evidence that there was more.
		const q = prepareQuery({ limit: 5 }, BASE);
		expect(q.limit).to.equal(5);
		expect(q.fetch).to.equal(6);
	});

	it('caps a limit the call asked for, and falls back when it sent none', () => {
		expect(prepareQuery({ limit: 500 }, BASE).limit).to.equal(20);
		expect(prepareQuery({}, BASE).limit).to.equal(20);
	});

	it('lets the call choose the order', () => {
		expect(prepareQuery({ sort: 'oldest' }, BASE).order).to.equal('ASC');
	});

	it('turns an absent exact match into a wildcard, not an empty string', () => {
		// `status = ''` matches nothing, which is the opposite of "no filter".
		expect(prepareQuery({}, { ...BASE, matches: [{ column: 'status' }] }).status).to.equal('%');
	});

	it('passes a match that was sent', () => {
		const q = prepareQuery({ status: 'confirmed' }, { ...BASE, matches: [{ column: 'status' }] });
		expect(q.status).to.equal('confirmed');
	});

	it('never turns limit or sort into a filter', () => {
		expect(prepareQuery({ limit: 3, sort: 'oldest' }, BASE).unused).to.deep.equal([]);
	});
});

describe('unused parameters', () => {
	it('names a declared parameter that no row reads', () => {
		// The tool offers `status`, the node has no match for it, so the filter
		// silently would not apply. Nothing else in the chain would notice.
		expect(prepareQuery({ status: 'confirmed' }, BASE).unused).to.deep.equal(['status']);
	});

	it('counts every configured filter as accounted for', () => {
		const q = prepareQuery(
			{ limit: 5, sort: 'oldest', created_after: 'x', id_after: 3, status: 'y' },
			{
				...BASE,
				ranges: [CREATED, { column: 'id', type: 'number' }],
				matches: [{ column: 'status' }],
			},
		);
		expect(q.unused).to.deep.equal([]);
	});
});

describe('likeValue', () => {
	it('escapes wildcards inside a real value', () => {
		// Otherwise a guest searching for "100%" matches every row.
		expect(likeValue('100%')).to.equal('100\\%');
		expect(likeValue('a_b')).to.equal('a\\_b');
	});
});

describe('sortDirection', () => {
	it('lets the call choose the order', () => {
		expect(sortDirection('oldest', 'DESC')).to.equal('ASC');
		expect(sortDirection('newest', 'ASC')).to.equal('DESC');
	});

	it('keeps the configured order when the call says nothing useful', () => {
		expect(sortDirection(undefined, 'DESC')).to.equal('DESC');
		expect(sortDirection('sideways', 'ASC')).to.equal('ASC');
	});
});
