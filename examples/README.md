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
| Read on from | `id_after` | `id_after` | `id_after` |
| Filter, sort, limit | Prepare Query → the Data Table node | `WHERE` / `ORDER BY` / `LIMIT` | the API's own parameters |
| Trim the columns | Edit Fields | Edit Fields | Edit Fields |
| `truncated` | Send Result, **Capped List** | same | same |

**The source does all of it.** Reading on by id rather than by offset is what
makes that possible: `id > 8` with a Limit is one comparison the source can do
itself,
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
the comparison is free, and an optional match gets a wildcard.

One key, one plain value. The comparison is chosen once from the dropdown, so it
is not in the data:

| Row | Column | Comparison | Value |
|---|---|---|---|
| range, lower | `createdAt` | Or Later | `{{ $json.q.createdAt_min }}` |
| range, upper | `createdAt` | Or Earlier | `{{ $json.q.createdAt_max }}` |
| optional match | `country` | Contains | `{{ $json.q.country }}` |
| read on | `id` | Greater Than | `{{ $json.q.id_min }}` |

Limit is `{{ $json.q.fetch }}`, one more than the answer carries, and Order is
`{{ $json.q.order }}`.

Reading on is not a mechanism of its own. It is a range on `id` configured like
any other, which is why nothing here knows the word cursor.

## Import

These exports name the nodes as they are called once the package is installed
from npm (`@loopthink/n8n-nodes-loopthink.loopthink`). A local checkout mounted through
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
| `limit` | number | Rows in one answer, default 20 |
| `sort` | string | `newest` (default) or `oldest`, by id, which is insertion order |
| `id_after` | number | The last id you were given, to read on from there |
| `created_after` / `created_before` | string | ISO bounds on the creation date |
| `country` | string | Only that country, omit for all |

Returns `{ items, truncated }`. `items` carries id, name, country and the
creation date, deliberately not the whole record.

There is no cursor and no `total`. The branch reads one row more than the limit;
if that extra row arrives, the answer is marked `truncated` and the extra row is
dropped. A model that sees it either narrows the filters or passes `id_after`
with the last id it was given. Both are ordinary filters it already understands,
so nothing opaque travels back and forth, and it can bisect a large range instead
of only walking forward.

Counting would be a second query for a number nobody acts on. The only question a
model has is whether to ask again, and `truncated` answers exactly that.

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

**n8n Data Table.** Reading on is by `id`, never by `createdAt`. A condition list
here is all ANDed or all ORed, so the `(createdAt, id)` tiebreak a non-unique sort
key needs cannot be written, and a strict `<` on a non-unique key silently skips
every row sharing the boundary value. Three of the seeded rows share a
millisecond, so this is not hypothetical. n8n gives every data table an
`id integer PRIMARY KEY`, unique and ascending with insertion, so ordering by it
is insertion order and no boundary can be ambiguous.

The `id` row is compared with **Greater Than**, not Or Later. That is what makes
`id_after` mean what it says instead of returning the boundary row a second time.

Bounds are filled with sentinels (`0001-01-01`, `9999-12-31`, a huge id) rather than
being left out, because a condition with an empty value fails with `Invalid date
string ''`. A sentinel keeps the condition list fixed and lets an absent
parameter mean "no bound".

**Postgres.** The whole query is one expression, so nothing here needs Prepare
Query. An absent bound simply drops out of the predicate:

```sql
WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
  AND ($3::int IS NULL OR id > $3::int)
ORDER BY id DESC
LIMIT $5
```

Bounds are parameters and are cast, so an absent one is a real `NULL`; passing
`''` instead fails the cast. The sort direction is the one thing SQL cannot take
as a parameter, and it is interpolated from an expression that can only ever
produce `ASC` or `DESC`, a whitelist by construction. Never interpolate a raw
tool parameter there.

An earlier version paged on the pair `(created_at, id)`, because ordering by a
timestamp alone skips rows that share a boundary value. Ordering by `id` makes
the pair unnecessary: it is unique, so no boundary is ambiguous, and the tool
exposes one plain `id_after` instead of an opaque `"<iso>|<id>"` token.

**HTTP API.** Use this when the platform cannot describe the call on its own: a
body to assemble, a response to reshape, a call to make first. A plain GET
against a documented path needs none of it; author that in loopthink as an HTTP
tool and the runner issues it with no workflow at all.

If the API pages by a token of its own, give the tool a parameter for it and read
the next one out of the response. The example does the simpler thing and passes
`id_after` and `limit + 1` straight into the query string. Credentials for your
own API stay in n8n, on the HTTP Request node. Verified
against a public JSON list API standing in for a customer's own.
