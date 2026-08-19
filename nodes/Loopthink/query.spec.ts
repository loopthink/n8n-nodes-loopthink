import { expect } from 'chai';

import {
	DATE_MAX,
	DATE_MIN,
	NUMBER_MAX,
	likeValue,
	prepareQuery,
	sortDirection,
} from './query';

// A Data Table condition row exists whether or not the call filled it. These
// cases are what keeps an unfilled row from excluding everything.

const BASE = {
	defaultLimit: 20,
	order: 'DESC' as const,
	cursorColumn: 'id',
	cursorType: 'number' as const,
};

describe('prepareQuery', () => {
	it('gives every entry the same two fields, whatever it filters on', () => {
		// The point of the shape: one way to fill a condition row, not three.
		const q = prepareQuery({}, {
			...BASE,
			ranges: [{ column: 'createdAt', type: 'date' }],
			matches: [{ column: 'status' }],
		});
		for (const key of ['id', 'createdAt_min', 'createdAt_max', 'status']) {
			expect(q[key], key).to.have.all.keys('condition', 'value');
		}
	});

	it('opens a range all the way up when the call sent neither bound', () => {
		const q = prepareQuery({}, { ...BASE, ranges: [{ column: 'createdAt', type: 'date' }] });
		expect(q.createdAt_min).to.deep.equal({ condition: 'gte', value: DATE_MIN });
		expect(q.createdAt_max).to.deep.equal({ condition: 'lte', value: DATE_MAX });
	});

	it('takes the bound that was sent and opens only the other side', () => {
		const q = prepareQuery(
			{ created_after: '2026-01-01' },
			{ ...BASE, ranges: [{ column: 'createdAt', parameter: 'created', type: 'date' }] },
		);
		expect(q.createdAt_min).to.have.property('value', '2026-01-01');
		expect(q.createdAt_max).to.have.property('value', DATE_MAX);
	});

	it('accepts any of the suffixes a tool might use for the same bound', () => {
		const ranges = [{ column: 'total_amount', type: 'number' as const }];
		expect(prepareQuery({ total_amount_min: 50 }, { ...BASE, ranges }).total_amount_min)
			.to.have.property('value', 50);
		expect(prepareQuery({ total_amount_from: 50 }, { ...BASE, ranges }).total_amount_min)
			.to.have.property('value', 50);
	});

	it('keys the cursor by the column it pages on', () => {
		const q = prepareQuery({}, { ...BASE, cursorColumn: 'booking_reference' });
		expect(q.booking_reference).to.have.property('condition', 'lt');
	});

	it('starts the first page at the far end, in the direction of the sort', () => {
		expect(prepareQuery({}, BASE).id).to.deep.equal({ condition: 'lt', value: NUMBER_MAX });
		expect(prepareQuery({}, { ...BASE, order: 'ASC' }).id).to.have.property('condition', 'gt');
	});

	it('seeks past the cursor it was given', () => {
		expect(prepareQuery({ cursor: 42 }, BASE).id).to.have.property('value', 42);
	});

	it('lets the call pick the order, and flips the cursor comparison with it', () => {
		const q = prepareQuery({ sort: 'oldest' }, BASE);
		expect(q.order).to.equal('ASC');
		expect(q.id).to.have.property('condition', 'gt');
	});

	it('caps a limit the call asked for, and falls back when it sent none', () => {
		expect(prepareQuery({ limit: 500 }, BASE).limit).to.equal(20);
		expect(prepareQuery({ limit: 5 }, BASE).limit).to.equal(5);
		expect(prepareQuery({}, BASE).limit).to.equal(20);
	});

	it('turns an absent exact match into a wildcard, not an empty string', () => {
		// `status = ''` matches nothing, which is the opposite of "no filter".
		const q = prepareQuery({}, { ...BASE, matches: [{ column: 'status' }] });
		expect(q.status).to.deep.equal({ condition: 'ilike', value: '%' });
	});

	it('passes a match that was sent', () => {
		const q = prepareQuery({ status: 'confirmed' }, { ...BASE, matches: [{ column: 'status' }] });
		expect(q.status).to.deep.equal({ condition: 'ilike', value: 'confirmed' });
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

describe('unused parameters', () => {
	it('names a declared parameter that no row reads', () => {
		// The tool offers `status`, the node has no match for it, so the filter
		// silently would not apply. Nothing else in the chain would notice.
		const q = prepareQuery({ status: 'confirmed', limit: 5 }, BASE);
		expect(q.unused).to.deep.equal(['status']);
	});

	it('counts paging and every configured filter as accounted for', () => {
		const q = prepareQuery(
			{ limit: 5, cursor: 3, sort: 'oldest', created_after: 'x', status: 'y' },
			{
				...BASE,
				ranges: [{ column: 'createdAt', parameter: 'created', type: 'date' }],
				matches: [{ column: 'status' }],
			},
		);
		expect(q.unused).to.deep.equal([]);
	});
});
