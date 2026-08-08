# n8n-nodes-loopthink

Run [loopthink](https://www.loopthink.ai) MCP tools from inside your own network.

The node reaches out to loopthink, claims tool calls, executes them against your
internal HTTP APIs, masks the results locally and sends them back. **Nothing has
to reach your n8n from the internet** — which is the whole point: it exists for
environments where the Docker runner cannot be deployed because inbound traffic
is not an option.

```
Claude ──► loopthink ──► queue ──┐
                                 │  n8n polls (outbound only)
                                 ▼
                          [loopthink Runner] ──► your internal API
                                 │
                          masked result ──► loopthink ──► Claude
```

## Install

Settings → Community Nodes → Install → `n8n-nodes-loopthink`

Self-hosted n8n only, as community nodes generally are.

## Set up

1. In loopthink, open your MCP server → **Runners** → **Add pull runner**.
2. Copy the block it shows — workspace ID, group ID, secret, API URL. The secret
   is displayed once and is not recoverable afterwards.
3. In n8n, create a **loopthink Runner API** credential and paste the four values.
4. Add the **loopthink Runner** node to a workflow and **activate** it.

That last step matters: while you are only running *Test workflow* in the editor,
the node listens for a short window and then stops. It polls continuously only
once the workflow is active.

### Credentials for your own systems

Add an optional **loopthink Target API** credential for the API the runner calls
(bearer token or a custom header). It stays in n8n. loopthink sends the request to
make — method, URL, masking rules — but never the key to make it with.

## How it behaves

- **Polling, not scheduling.** The loop lives inside the node, so no execution is
  created while there is nothing to do. A Schedule trigger at one second would
  produce ~2.6 million executions a month, over 99% of them finding nothing.
- **Poll interval is latency.** It is the delay added to every tool call. 1–5
  seconds is the sensible range; every poll is also a request loopthink pays for.
- **Bursts are handled without waiting.** After a call is answered the node checks
  again immediately rather than sleeping out the interval.
- **Executions are your audit trail.** One per tool call, with the tool name, the
  URL, the status and how many masking rules applied. Turn it off with
  *Emit Results* if you would rather keep the list clean.
- **Transient failures do not stop it.** A failed poll is logged and retried;
  stopping would leave the runner silently dead until someone noticed.

## Masking

Masking runs **here**, before anything travels back — only masked data ever passes
through the loopthink cloud.

The rules are not configured in n8n. They arrive with each request, so a rule you
add in loopthink takes effect on the very next tool call without anyone touching
this workflow.

One thing worth knowing: a rule with an entity **scope** only applies when the
target entity is known, which for HTTP tools it usually is not. Configure masking
for HTTP tools **without** a scope, or it will silently do nothing.

## Scope

This release covers **HTTP tools**. Database, HubSpot and Salesforce importers are
not executed by this node yet.

## Develop

```bash
npm install
npm test
npm run build
```

### Local test rig

A compose file brings up n8n with this node already loaded, plus an echo service
to point tool calls at — so you can exercise a full round trip without a real
internal system:

```bash
npm run docker:up
```

n8n comes up on <http://localhost:5678>. From inside the workflow the echo service
is reachable at `http://echo:8080` — it returns whatever you send it, which makes
it easy to watch masking work on fields you choose.

```bash
npm run docker:restart   # rebuild + reload after a code change
npm run docker:logs      # follow n8n's log
npm run docker:down      # stop and remove the volume
```

The node is mounted from `./dist`, so a change needs a build before it is visible
in the container. `npm run dev` (tsc in watch mode) plus `docker:restart` is the
quickest loop.

Custom nodes are loaded from `/custom` rather than `~/.n8n/custom` on purpose:
that path lives inside n8n's data volume, and the two mounts would otherwise
shadow each other depending on mount order.

## License

MIT
