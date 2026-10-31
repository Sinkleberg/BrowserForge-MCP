# Architecture

```
 Codex / Claude Code                    Firefox or Chrome
        │  MCP (Streamable HTTP, Bearer)        ▲
        ▼                                       │ WebExtension APIs
 ┌──────────────────────────────┐  ws://127.0.0.1:PORT/ext   ┌────────────────────────┐
 │ browserforge daemon          │◄──────────────────────────►│ BrowserForge extension │
 │  • MCP server (tools)        │  token + Origin + schema   │  • background          │
 │  • BrowserHub (requests,     │                            │  • content script      │
 │    timeouts, cancel, resume) │                            │  • popup (approvals,   │
 │  • NetworkStore (in memory)  │                            │    STOP, tabs, log)    │
 │  • analyzer / generator      │                            └────────────────────────┘
 │  • workflows, profiles       │
 └──────────────────────────────┘
```

## Components

| Path | Role |
|---|---|
| `apps/firefox-extension` | One TypeScript source, two builds (`dist/firefox`, `dist/chrome`; plus `-e2e` variants for tests). Name kept from the required layout; it contains the cross-browser extension. |
| `apps/mcp-server` | Daemon: HTTP + WebSocket listener, MCP tools (`tools/*.ts`), `hub.ts`, workflows, profiles, form mapping, CLI. |
| `packages/browser-protocol` | Zod schemas for every message and every browser action (`actions.ts`). |
| `packages/network-inspector` | In-memory store, filters, pagination, redacted views, HAR import/export. |
| `packages/api-analyzer` | Traffic → endpoint families, schemas, pagination, auth, GraphQL, errors, confidence/evidence. |
| `packages/client-generator` | OpenAPI 3.1 + Python/TypeScript/JavaScript/PHP clients, secret scan, safe writer, validation runner. |
| `packages/shared` | Errors, limits, redaction, path safety, tokens, redacting logger. |
| `tests/` | `unit`, `security`, `integration` (MCP over HTTP), `e2e` (real Firefox + Chromium), `fixtures/demo-site`. |

## Key decisions

1. **Daemon + HTTP transport.** Codex and Claude Code can both talk to the same browser. `browserforge stdio` runs the same code for a single client.
2. **Approval is enforced in the extension, not the MCP client.** MCP elicitation support varies; a human click in the extension popup cannot be answered by the agent. Consequential clicks/typing/fills/uploads return to the agent only after the human decides (see `docs/SECURITY.md`).
3. **Element refs carry a per-page epoch** (`<epoch>:<n>`); after navigation they fail with `STALE_REF` instead of acting on a different element.
4. **Everything is idempotent by request id.** The extension caches the last 200 responses; the hub re-sends unanswered requests after a reconnect; duplicates are ignored.
5. **Capture is observation only.** `webRequest` (both browsers) records metadata/headers/request bodies; response bodies are opt-in (`filterResponseData` on Firefox, `chrome.debugger` on Chrome).
6. **Redaction at the view layer.** The store keeps raw values in memory so analysis and reveal-for-debugging work; every tool output, HAR export and generated artifact passes through redaction, and nothing is persisted unless the user exports.
7. **No LLM anywhere.** Analysis and code generation are deterministic.

## Data flow: a click

1. MCP tool `browser_click` → Zod-validated → `hub.call('click', …)` with timeout/abort.
2. Hub sends `{v,type:"request",id,action,args}` to the extension.
3. Background validates args again, checks pause/stop, resolves the tab, calls the content script.
4. Content script resolves the ref/selector; if the element looks consequential it answers `needsApproval`.
5. Background shows the prompt (badge + popup), waits for the human, then re-invokes the content script with `approved=true` (a flag only the background can set).
6. Result flows back; the hub resolves the MCP call.


## Extensions: flows, plugins and skills

* **Flows** (`packages/flows`, `apps/mcp-server/src/flows`): the content script describes every element an action touched (`computeLocator`: test id, role and name, label, id, CSS, XPath) and returns it in the reply as `_flow`. The hub strips that from what the agent sees and emits `actionDone`; the recorder groups actions per task and site, turns typed values into parameters and writes JSON. Exporters are pure functions over that JSON. `flow_run` replays by asking the content script to `resolve_locator` for each step, then using the normal actions, so approvals still apply.
* **Plugins** (`packages/plugin-sdk`, `apps/mcp-server/src/plugins`): installed with `npm install --ignore-scripts` into `<config>/plugins/<id>/pkg`, recorded with the permissions the user approved. At startup the loader imports each enabled plugin, refuses it if its manifest permissions differ from what was approved, if a tool name does not start with its prefix or collides, and registers its tools through the same `registerTool` as core tools. Plugins receive only a `PluginApi`: checked files, declared programs, optional browser calls, logging.
* **Skills** (`apps/mcp-server/src/plugins/skills.ts`, `tools/skills.ts`): folders with `SKILL.md` and workflows, exposed as MCP prompts and `skill_*` tools; workflows run through the existing workflow engine.

None of these can reach the approval gate: it lives in the extension.
