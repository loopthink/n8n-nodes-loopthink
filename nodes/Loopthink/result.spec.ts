import { expect } from 'chai';

import { executeResult } from './result.operation';

/**
 * The size guard, exercised through the node rather than around it.
 *
 * The thing worth proving is not that a number comparison works. It is that a
 * result over budget leaves as an *error the model can read* and that the rows
 * do not leave at all — which is only observable from the body that reaches the
 * queue, so that is what these assert on.
 */

interface Sent {
	url: string;
	body: any;
}

function context(options: {
	items: any[];
	respondWith?: 'object' | 'list' | 'page';
	pageSize?: number;
	sent: Sent[];
}) {
	const params: Record<string, any> = {
		request: { requestId: 'req-1', masking: [], scope: null },
		respondWith: options.respondWith ?? 'list',
		status: 200,
		pageSize: options.pageSize ?? 20,
	};

	return {
		getInputData: () => options.items.map((json) => ({ json })),
		getCredentials: async () => ({
			queueUrl: 'https://queue.example/',
			workspaceId: 'ws',
			groupId: 'grp',
			secret: 's',
		}),
		getNodeParameter: (name: string) => params[name],
		getNode: () => ({ name: 'loopthink' }),
		helpers: {
			httpRequest: async (request: any) => {
				options.sent.push({ url: request.url, body: request.body });
				return { accepted: true };
			},
			returnJsonArray: (rows: any[]) => rows.map((json) => ({ json })),
		},
	} as any;
}

/** Rows that add up to more than one answer can carry. */
function bulkyRows(count: number): any[] {
	return Array.from({ length: count }, (_, i) => ({
		id: i,
		guest: `Guest number ${i} with a name long enough to matter`,
		note: 'x'.repeat(400),
	}));
}

describe('A result over the size budget', () => {
	it('sends a sentence instead of the rows', async () => {
		const sent: Sent[] = [];
		await executeResult.call(context({ items: bulkyRows(1625), sent }));

		expect(sent).to.have.length(1);
		const { body } = sent[0];
		// The rows must not travel: a partial answer read as a whole one is worse
		// than no answer, because nothing about it says it was cut short.
		expect(body).to.not.have.property('data');
		expect(body.error).to.be.a('string');
	});

	it('names the size and the two ways to ask for less', async () => {
		const sent: Sent[] = [];
		await executeResult.call(context({ items: bulkyRows(1625), sent }));

		const { error } = sent[0].body;
		expect(error).to.contain('1,625 rows');
		expect(error).to.contain('300 KB');
		expect(error).to.contain('narrow the filters');
		expect(error).to.contain('smaller limit');
		// A status code is a fact about our queue. The model did not cause it and
		// cannot act on it.
		expect(error).to.not.contain('413');
	});

	it('counts the rows of a capped list, not the envelope around them', async () => {
		const sent: Sent[] = [];
		await executeResult.call(
			context({ items: bulkyRows(900), respondWith: 'page', pageSize: 800, sent }),
		);

		// `{ items, truncated }` is one object; the number the model needs is how
		// many rows were in it.
		expect(sent[0].body.error).to.contain('800 rows');
	});

	it('leaves an answer within budget completely alone', async () => {
		const sent: Sent[] = [];
		await executeResult.call(context({ items: bulkyRows(10), sent }));

		const { body } = sent[0];
		expect(body).to.not.have.property('error');
		expect(body.status).to.equal(200);
		expect(body.data).to.have.length(10);
	});

	it('measures the masked copy, because that is the one that travels', async () => {
		const sent: Sent[] = [];
		const ctx = context({ items: bulkyRows(1000), sent });
		// A rule that empties the field carrying the weight. Before masking this
		// is far over budget; after it, it fits — and after is what matters.
		ctx.getNodeParameter = (name: string) =>
			({
				request: { requestId: 'req-1', masking: [{ field: 'note', strategy: 'remove' }], scope: null },
				respondWith: 'list',
				status: 200,
				pageSize: 20,
			})[name];

		await executeResult.call(ctx);
		expect(sent[0].body).to.not.have.property('error');
		expect(sent[0].body.data).to.have.length(1000);
	});
});
