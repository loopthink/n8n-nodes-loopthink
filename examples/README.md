# Example workflows

Three workflows answering the same pair of tools, an `index` and a `show`, over
three different sources. All three were run end to end against a loopthink stage
environment before being exported.

They share one shape:

```
[loopthink Runner] → [Switch on {{$json.tool}}]
                        ├ …_index → read → [Keep index fields] ─┐
                        ├ …_show  → read ───────────────────────┤
                        └ unhandled ────────────────────────────┤
                                                 [loopthink] ◄───┘
```

The runner does not know which tools this workflow answers. It emits every
claimed call on its one output and the Switch decides, with the names where you
can read them.

| | [data-table.json](data-table.json) | [postgres.json](postgres.json) | [http-api.json](http-api.json) |
|---|---|---|---|
| Source | n8n Data Table | Postgres | any HTTP API |
| Cursor key | row `id` | `(created_at, id)`, selected as one `cursor` column | whatever the API pages by |
| Filter, sort, page | Prepare Query → the Data Table node | `WHERE` / `ORDER BY` / `LIMIT` | the API's own parameters |
| Trim the columns | Edit Fields | Edit Fields | Edit Fields |
| `nextCursor`, `hasMore` | Send Result, **Page of Objects** | same | same |

**The source does all of it.** Paging by cursor rather than offset is what makes
that possible: `id < c` with a Limit is one comparison the source can do itself,
and it hands back only the page. Offset made it hand over every row so the
workflow could slice them, and it shifted the whole listing under the caller
whenever a row was inserted between two pages.

Everything after the source is a standard n8n node: Edit Fields keeps the columns
the index tool is meant to expose. loopthink's own node bundles the rows, hands
out the cursor, masks the answer and sends it.

### Why the Data Table workflow has a Prepare Query in front of it

The other two sources take the whole query as one expression, a SQL statement or a
URL. The Data Table node does not: its conditions are rows in the editor, fixed
when the workflow is built, and the list as a whole cannot come from an
expression (n8n walks a string handed to a multi-value collection character by
character and quietly produces one empty condition per character).

So the rows have to be there whether or not the call filled them, and each one
needs a value that cannot exclude anything when it was not filled. **Prepare
Query** produces those values: a range gets a bound so far outside the data that
the comparison is free, an optional match gets a wildcard, and the first page
starts at the far end.

Every entry has the same two fields, so every row is wired the same way:

| Row | Column | Condition | Value |
|---|---|---|---|
| cursor | `id` | `{{ $json.q.id.condition }}` | `{{ $json.q.id.value }}` |
| range, lower | `createdAt` | `{{ $json.q.createdAt_min.condition }}` | `{{ $json.q.createdAt_min.value }}` |
| range, upper | `createdAt` | `{{ $json.q.createdAt_max.condition }}` | `{{ $json.q.createdAt_max.value }}` |
| optional match | `country` | `{{ $json.q.country.condition }}` | `{{ $json.q.country.value }}` |

The cursor row is always `id`: n8n gives every data table one, and it is the only
column keyset paging can trust, so the node does not offer the choice.

Pick the column, then paste the same pair with the column's key. Which comparison
a row needs is the node's decision: an equals where a bound belongs still runs,
it just answers with nothing.

## Import

These exports name the nodes as they are called once the package is installed
from npm (`n8n-nodes-loopthink.loopthink`). A local checkout mounted through
`N8N_CUSTOM_EXTENSIONS` registers the same nodes under `CUSTOM.` instead, and an
import naming the other one arrives as an unrecognised node. Search and replace
the prefix if you are running the development rig.

1. Replace the placeholders: `<LOOPTHINK_CREDENTIAL_ID>` plus `<DATA_TABLE_ID>`,
   `<POSTGRES_CREDENTIAL_ID>` or `<API_BASE_URL>`. Easiest is to import first and
   pick the credential and table from the dropdowns in the editor.
2. Create the tools in loopthink with **Implementation: Workflow** and the
   parameters below. The tool name is the contract: it has to match the Switch.
3. Activate the workflow. It polls only while active; *Test workflow* listens
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

Returns `{ items, nextCursor, hasMore }`, the same shape n8n's own public API
uses. `items` carries id, name, country and the creation date, deliberately not
the whole record.

No `total`: counting is a second query, and with a cursor the only question is
whether to ask again. `hasMore` answers that: a full page is the sole evidence
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
key needs cannot be written, and a strict `<` on a non-unique key silently skips
every row sharing the boundary value. Three of the seeded rows share a
millisecond, so this is not hypothetical. The id is unique and ascends with
insertion, so ordering by it is insertion order.

Bounds are filled with sentinels (`0001-01-01`, `9999-12-31`, a huge id) rather than
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

The cursor is `"<iso>|<id>"`, opaque to the caller. Send Result reads one named
field, so the pair is assembled in the SELECT as a `cursor` column and travels
with each row: any row in a page can be the one you continue from. Bounds are parameters and are
cast, so an absent one is a real `NULL` and the predicate drops out; passing `''`
instead fails the cast. The two things SQL cannot take as parameters, the sort
direction and the comparison operator, are interpolated from one expression that
can only ever produce `ASC`/`DESC` and `<`/`>`, a whitelist by construction. Never
interpolate the raw tool parameter there.

**HTTP API.** Use this when the platform cannot describe the call on its own: a
body to assemble, a response to reshape, a call to make first. A plain GET
against a documented path needs none of it; author that in loopthink as an HTTP
tool and the runner issues it with no workflow at all.

An API that pages by its own token is the easy case: hand the cursor back
untouched and read the next one out of the response instead of off the last row.
Credentials for your own API stay in n8n, on the HTTP Request node. Verified
against a public JSON list API standing in for a customer's own.
