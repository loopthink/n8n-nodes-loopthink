# Example workflows

Three workflows answering the same pair of tools, an `index` and a `show`, over
three different sources. All three were run end to end against a loopthink stage
environment before being exported.

They share one shape:

```
[loopthink Runner] ─ Executed ─────────────────────────► (audit trail)
                   └ To Answer → [Switch on {{$json.tool}}]
                                    ├ …_index → read → [loopthink: Build Index Page] ─┐
                                    ├ …_show  → read ──────────────────────────────────┤
                                    └ unhandled ───────────────────────────────────────┤
                                                            [loopthink: Send Result] ◄─┘
```

The runner does not know which tools this workflow answers. It emits every
workflow tool on **To Answer** and the Switch decides, with the names where you
can read them.

| | [data-table.json](data-table.json) | [postgres.json](postgres.json) | [http-api.json](http-api.json) |
|---|---|---|---|
| Source | n8n Data Table | Postgres | any HTTP API |
| Sorting | the Data Table node | `ORDER BY` | Build Index Page |
| Fixed filters | the Data Table node | `WHERE` | Build Index Page |
| Optional date bounds | Build Index Page | `WHERE`, cast so `NULL` drops out | Build Index Page |
| Paging, envelope, field trim | Build Index Page | `LIMIT/OFFSET` + `count(*) OVER ()`, envelope from Build Index Page | Build Index Page |

**Let the source do what it does well.** A database filters, orders and pages
better than any node can, and on a table of real size it is the only place that
scales — there, Build Index Page runs with *Rows Are Already Paged* and only
shapes the answer. A Data Table sorts and filters natively too; what it cannot do
is leave a filter out, page from an offset, or count the total.

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
| `offset` | number | Rows to skip, for the next page |
| `sort` | string | `newest` (default) or `oldest`, by creation date |
| `created_after` / `created_before` | string | ISO bounds on the creation date |
| `updated_after` / `updated_before` | string | ISO bounds on the last change |

Returns `{ items, total, offset, limit, hasMore }`. `items` carries id, name,
country and the creation date — deliberately not the whole record.

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

**n8n Data Table.** Sorting goes in the node (*Order By*). Fixed filters can too:
the node converts an ISO string to a real Date for date columns, so a date
condition is correct. An *optional* bound cannot: leaving the value empty fails
with `Invalid date string ''`, so bounds driven by a tool parameter stay in Build
Index Page, where an empty bound is simply not applied.

**Postgres.** Two details that are easy to get wrong:

```sql
WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
ORDER BY created_at DESC, id DESC
LIMIT $5 OFFSET $6
```

Bounds are parameters and are cast, so an absent one is a real `NULL` and the
predicate drops out; passing `''` instead fails the cast. And the sort direction
cannot be a parameter, so it is interpolated — from an expression that can only
ever produce `ASC` or `DESC`, a whitelist by construction. Never interpolate the
raw tool parameter there.

**HTTP API.** Use this when the platform cannot describe the call on its own: a
body to assemble, a response to reshape, a call to make first. A plain GET
against a documented path needs none of it — author that in loopthink as an HTTP
tool and the runner issues it with no workflow at all. Credentials for your own
API stay in n8n, on the HTTP Request node. Verified against a public JSON list
API standing in for a customer's own.
