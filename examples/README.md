# Example workflows

Three workflows answering the same pair of tools, an `index` and a `show`, over
three different sources. All three were run end to end against a loopthink stage
environment before being exported.

They share one shape:

```
[loopthink Runner] ─ Executed ─────────────────────────► (audit trail)
                   └ To Answer → [Switch on {{$json.tool}}]
                                    ├ …_index → read → [Aggregate] → [Edit Fields] ─┐
                                    ├ …_show  → read ────────────────────────────────┤
                                    └ unhandled ─────────────────────────────────────┤
                                                                    [loopthink] ◄─────┘
```

The runner does not know which tools this workflow answers. It emits every
workflow tool on **To Answer** and the Switch decides, with the names where you
can read them.

| | [data-table.json](data-table.json) | [postgres.json](postgres.json) | [http-api.json](http-api.json) |
|---|---|---|---|
| Source | n8n Data Table | Postgres | any HTTP API |
| Cursor key | row `id` | `(created_at, id)` | whatever the API pages by |
| Filter, sort, page | the Data Table node | `WHERE` / `ORDER BY` / `LIMIT` | the API's own parameters |
| Bundle and trim | Aggregate | Aggregate | Aggregate |
| `nextCursor`, `hasMore` | Edit Fields | Edit Fields | Edit Fields |

**The source does all of it.** Paging by cursor rather than offset is what makes
that possible: `id < c` with a Limit is one comparison the source can do itself,
and it hands back only the page. Offset made it hand over every row so the
workflow could slice them, and it shifted the whole listing under the caller
whenever a row was inserted between two pages.

Everything after the source is a standard n8n node — Aggregate bundles the rows
into one item and trims the columns, Edit Fields adds the cursor. loopthink's own
node does one thing: mask the answer and send it.

## Import

1. Replace the placeholders: `<LOOPTHINK_CREDENTIAL_ID>` plus `<DATA_TABLE_ID>`,
   `<POSTGRES_CREDENTIAL_ID>` or `<API_BASE_URL>`. Easiest is to import first and
   pick the credential and table from the dropdowns in the editor.
2. Create the tools in loopthink with **Implementation: Workflow** and the
   parameters below. The tool name is the contract: it has to match the Switch.
3. Activate the workflow. It polls only while active — *Test workflow* listens
   for a short window and stops.

One runner per MCP server. Two active workflows sharing one runner credential
would compete for the same queue, and whichever claimed a request first would
answer it, branch or no branch.

## The tools

`*_index`, all parameters optional:

| Parameter | Type | Meaning |
|---|---|---|
| `limit` | number | Rows per page, default 20 |
| `cursor` | string | `nextCursor` from the previous response; omit for the first page |
| `sort` | string | `newest` (default) or `oldest`, by creation date |
| `created_after` / `created_before` | string | ISO bounds on the creation date |
| `updated_after` / `updated_before` | string | ISO bounds on the last change |

Returns `{ items, nextCursor, hasMore }` — the same shape n8n's own public API
uses. `items` carries id, name, country and the creation date, deliberately not
the whole record.

No `total`: counting is a second query, and with a cursor the only question is
whether to ask again. `hasMore` answers that — a full page is the sole evidence
there may be more, so a listing that ends on an exact multiple of `limit` costs
one extra call to discover it is finished.

`*_show` takes a required `id` and returns the full record.

Masking rules used throughout: `iban` → mask, email pattern → pseudonymize. They
are configured in loopthink and travel with each request, so changing them needs
no change here.

## Why an index is not just a smaller list

The fields left out of `*_index` never travel at all. Masking protects a value on
its way through; omitting the field means there is nothing to protect. A model
that needs the email asks `*_show` for one record, and that single call is the
one that carries it.

## Notes per source

**n8n Data Table.** The cursor is the row `id`, not `createdAt`. A condition list
here is all ANDed or all ORed, so the `(createdAt, id)` tiebreak a non-unique sort
key needs cannot be written — and a strict `<` on a non-unique key silently skips
every row sharing the boundary value. Three of the seeded rows share a
millisecond, so this is not hypothetical. The id is unique and ascends with
insertion, so ordering by it is insertion order.

Every bound gets a sentinel (`0001-01-01`, `9999-12-31`, a huge id) rather than
being left out, because a condition with an empty value fails with `Invalid date
string ''`. A sentinel keeps the condition list fixed and lets an absent
parameter mean "no bound".

**Postgres.** SQL can express the tiebreak the Data Table cannot, so here the
order really is by date with the id only deciding ties:

```sql
WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
  AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::int))
ORDER BY created_at DESC, id DESC
LIMIT $7
```

The cursor is `"<iso>|<id>"`, opaque to the caller. Bounds are parameters and are
cast, so an absent one is a real `NULL` and the predicate drops out; passing `''`
instead fails the cast. The two things SQL cannot take as parameters — the sort
direction and the comparison operator — are interpolated from one expression that
can only ever produce `ASC`/`DESC` and `<`/`>`, a whitelist by construction. Never
interpolate the raw tool parameter there.

**HTTP API.** Use this when the platform cannot describe the call on its own: a
body to assemble, a response to reshape, a call to make first. A plain GET
against a documented path needs none of it — author that in loopthink as an HTTP
tool and the runner issues it with no workflow at all.

An API that pages by its own token is the easy case: hand the cursor back
untouched and read the next one out of the response instead of off the last row.
Credentials for your own API stay in n8n, on the HTTP Request node. Verified
against a public JSON list API standing in for a customer's own.
