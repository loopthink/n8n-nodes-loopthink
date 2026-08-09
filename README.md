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

## Two nodes, one runner

| | **loopthink Runner** | **loopthink Runner (WebSocket)** |
|---|---|---|
| How work arrives | polled every few seconds | pushed the moment it is queued |
| Latency added | half the poll interval | none |
| Needs | plain HTTPS | a network that allows WebSocket upgrades |
| Cost to loopthink | ~$6 per runner/month | ~$0.04 |

Both serve the same queue and can even run against the same group, so switching
loses nothing: work a socket does not take stays queued for a polling runner.

**Start with the WebSocket node.** If it cannot connect, it says so in the log
after three attempts — that is the answer, and the polling node is the fallback.
Corporate proxies and TLS inspection are the usual reason an upgrade fails.

## Install

Settings → Community Nodes → Install → `n8n-nodes-loopthink`

Self-hosted n8n only, as community nodes generally are.

## Set up

1. In loopthink, open your MCP server → **Runners** → **Add pull runner**.
2. Copy the block it shows — workspace ID, group ID, secret, queue URL. The secret
   is displayed once and is not recoverable afterwards.
3. In n8n, create a **loopthink Runner API** credential (the node's
   **Authentication** slot) and paste the four values. Saving it runs a
   connection check against the queue, so a wrong value shows up right away.
4. Add a runner node to a workflow and **activate** it (see the table above for which).

That last step matters: while you are only running *Test workflow* in the editor,
the node listens for a short window and then stops. It polls continuously only
once the workflow is active.

### Secrets for your own systems

In loopthink you configure the *shape* of a request — which header, which URL —
and write `{{secret.NAME}}` where a value belongs:

```
Header  X-API-Key: {{secret.CRM_API_KEY}}
```

Then add a **loopthink Target Secrets** credential in n8n (the node's **Secrets**
slot) with a `CRM_API_KEY` entry. The runner fills the placeholder in on the way out. loopthink sends the
request to make, never the key to make it with — the secret is never stored there
and never travels.

Two behaviours worth knowing:

- **A missing secret refuses the call.** The literal placeholder is never sent;
  it would earn a 401 and leave `{{secret.CRM_API_KEY}}` in the target's access
  log. The error names what is missing.
- **Execution records show the unresolved form.** A substituted URL can contain a
  secret, and n8n stores execution data.

A placeholder in a **URL** ends up in the target's access log and in any proxy in
between. Sometimes an API leaves no choice — but prefer a header where you have one.

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

n8n comes up on <http://127.0.0.1:5680> (override with `LOOPTHINK_N8N_PORT`). From inside the workflow the echo service
is reachable at `http://echo:8080` — it returns whatever you send it, which makes
it easy to watch masking work on fields you choose.

```bash
npm run docker:restart   # rebuild + reload after a code change
npm run docker:logs      # follow n8n's log
npm run docker:down      # stop and remove the volume
```

`npm run dev` watches TypeScript and icons; with `N8N_DEV_RELOAD` set in the
compose file, n8n picks the rebuilt files up without a container restart. The
browser still needs a refresh to fetch the new node definition.

`docker:restart` remains for the cases dev reload does not cover (a changed
credential class, or anything in docker-compose.yml). It force-recreates rather
than restarts, because `docker compose restart` would not re-resolve the mount.

The whole package is mounted, not just `./dist`: the build begins with
`rimraf dist`, and a bind mount pointing at a directory that gets deleted leaves
the container holding a dangling inode. Every later rebuild would then be
invisible to it — silently, with the node still running whatever loaded at startup.

Custom nodes are loaded from `/custom` rather than `~/.n8n/custom` on purpose:
that path lives inside n8n's data volume, and the two mounts would otherwise
shadow each other depending on mount order.

## License

MIT
