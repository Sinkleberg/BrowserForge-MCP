# Research notes

Date of inspection: 2026-10-26. Both projects were cloned (shallow) into an isolated temporary directory and **read only** — nothing from them was executed, installed or copied into this repository.

## Blueprint MCP — `railsblueprint/blueprint-mcp`

| | |
|---|---|
| Commit inspected | `699be5e` (2026-08-10), version 1.9.22 |
| Licence | **Apache-2.0** (`LICENSE`, `package.json`) |
| Server | Node ≥ 18, `@modelcontextprotocol/sdk`, `ws`, `commander`, `sharp`, … (`server/package.json`) |
| Transport | MCP over stdio; server ↔ browser extension over WebSocket on `localhost:5555`; optional **cloud relay (PRO tier, OAuth login)** |
| Browsers | Separate extensions for Chrome, Edge, Opera, Firefox, Safari. Firefox: Manifest V3, plain JS, permissions include `tabs, activeTab, webNavigation, webRequest, storage, management, scripting, alarms` + `<all_urls>` |
| Tools | `browser_navigate`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_snapshot`, `browser_take_screenshot`, `browser_network_requests`, `browser_file_upload`, … and **`browser_evaluate`** (arbitrary JS in the page) |

**What we reuse:** nothing at the code level. We reuse the *idea* (a local MCP server bridged to a browser extension over a loopback WebSocket), which is a general architecture, not protectable expression.

**Why not wrap or fork it:**
- The product requirements (versioned, schema-validated protocol; token-authenticated WebSocket with Origin/Host validation; human approval gates enforced *in the extension*; redacted network capture; reverse-API engine; client generator) change the core design, not just add tools.
- It exposes `browser_evaluate` (arbitrary page JS) and needs the `management` permission; BrowserForge deliberately has neither.
- The paid relay is cloud-based; BrowserForge is local-only.
- Apache-2.0 would have allowed reuse with attribution (`NOTICE`, preserved headers), but there was no code worth taking. If code is ever taken, add a notice to `NOTICE`.

## Reverse API Engineer — `nottelabs/reverse-api-engineer`

| | |
|---|---|
| Commit inspected | `b933703` (2026-10-25), version 0.14.0 |
| Licence | **MIT** (`LICENSE`, `pyproject.toml`) |
| Language | Python ≥ 3.11; CLI (`click`), not a library API |
| Dependencies | `claude-agent-sdk`, `playwright`, `playwright-stealth`, `cryptography`, `starlette`, … |
| Capture | HAR via Playwright / Chrome DevTools MCP / agent-browser |
| Generation | **An LLM agent reads the HAR and writes the client** — requires a model provider/API key for agent mode |

**What we reuse:** the *workflow concept* (capture → HAR → documented API → generated client).

**Why not integrate it:**
- The core requirement is no paid service and a deterministic result without an LLM. Its generation step is an LLM agent.
- It is a Python CLI; BrowserForge's analyzer/generator run in-process in the TypeScript MCP server.
- It depends on `playwright-stealth`, which exists to evade bot detection. BrowserForge's policy is not to bypass anti-bot restrictions.

**What we built instead:** a deterministic pipeline (`packages/api-analyzer`, `packages/client-generator`) where every inferred item is labelled `observed` / `inferred` / `hypothesis`, carries a confidence level, and lists the captured request ids that support it. HAR files produced by any tool (including Reverse API Engineer) can be imported with `network_import_har` and analysed.

## Firefox WebExtensions (MDN)

- Manifest V3 is supported; Firefox uses an **event page** (`background.scripts`), not a service worker.
- `webRequest` observation (non-blocking) is available to MV3 extensions; request bodies are delivered via `requestBody` in `onBeforeRequest`.
- Response bodies are only available through `webRequest.filterResponseData`, which needs `webRequest` + `webRequestBlocking` + `webRequestFilterResponse` (Firefox ≥ 110 for MV3). BrowserForge requests these as **optional permissions** and only when the user turns on body capture.
- There is no DevTools Protocol in Firefox for extensions (WebDriver BiDi is a separate, external channel). Consequently WebSocket frames, service-worker-internal traffic, streaming bodies and requests from privileged pages cannot be captured. See `docs/LIMITATIONS.md`.
- Content scripts run in an isolated world; extensions cannot script `about:`, `moz-extension:`, addons.mozilla.org, or other privileged pages.
- `data_collection_permissions` in `browser_specific_settings.gecko` requires Firefox 140+ (hence `strict_min_version: 140.0`).

## Chrome (MV3)

- Background is a **service worker** that Chrome terminates when idle; BrowserForge keeps it alive with a 15 s WebSocket ping and an `alarms` reconnect, and treats every request as idempotent (request-id dedupe) so a restart is harmless.
- `chrome.debugger` (DevTools Protocol) gives response bodies and WebSocket frames; it is an **optional permission**, Chrome shows its own "debugging this browser" banner while attached, and it is off unless body capture is enabled.
- Since Chrome 137, branded Chrome ignores `--load-extension`; automated tests therefore use Playwright's Chromium build. Users load the unpacked extension manually.

## Model Context Protocol

- Official TypeScript SDK `@modelcontextprotocol/sdk` 1.32.2 (pinned). Tools registered with `registerTool`, strict Zod input schemas, `readOnlyHint`/`destructiveHint` annotations.
- Transports: **Streamable HTTP** and **stdio**. BrowserForge's primary mode is a local daemon serving Streamable HTTP so Codex and Claude Code can share one browser; `stdio` mode embeds the same server for single-client use.
- Client configuration differs: Codex uses `~/.codex/config.toml` (`[mcp_servers.<name>]`, `url`, `bearer_token_env_var`); Claude Code uses `claude mcp add --transport http … --header …` or `.mcp.json`. Both were exercised for real; see `docs/CODEX.md` and `docs/CLAUDE_CODE.md`.
