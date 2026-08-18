# Example workflows

Two workflows answering the same shape of tool — an `index` and a `show` — over
two different sources. Both were run end to end against a loopthink stage
environment before being exported.

| | [data-table.json](data-table.json) | [postgres.json](postgres.json) |
|---|---|---|
| Source | n8n Data Table | Postgres |
| Who filters, sorts, pages | loopthink Page | the database |
| loopthink Page does | everything | the envelope and the column trim |

## Import

1. Replace the placeholders: `<LOOPTHINK_CREDENTIAL_ID>`, and
   `<DATA_TABLE_ID>` or `<POSTGRES_CREDENTIAL_ID>`. Easiest is to import first
   and pick the credential and table from the dropdowns in the editor.
2. Create the tools in loopthink with **Implementation: Workflow** and the
   parameters below. The tool name is the contract: it has to match the entry
   under **Workflow Tools** on the runner node.
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

Masking rules used in both: `iban` → mask, email pattern → pseudonymize. They are
configured in loopthink and travel with each request, so changing them needs no
change here.

## Why an index is not just a smaller list

The fields left out of `*_index` never travel at all. Masking protects a value on
its way through; omitting the field means there is nothing to protect. A model
that needs the email asks `*_show` for one record, and that single call is the
one that carries it.

## Postgres specifics

The query does the work, which is the only thing that scales past a toy table:

```sql
SELECT id, name, country, created_at, updated_at, count(*) OVER () AS total
FROM customers
WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
  ...
ORDER BY created_at DESC, id DESC
LIMIT $5 OFFSET $6
```

Two details that are easy to get wrong:

- **Bounds are parameters and are cast.** An absent one is a real `NULL` and the
  predicate drops out. Passing `''` instead fails the cast, which is the usual
  way an optional date filter breaks.
- **Sort direction cannot be a parameter.** It is interpolated, and the
  expression can only ever produce `ASC` or `DESC` — a whitelist by construction.
  Never interpolate the raw tool parameter there.
