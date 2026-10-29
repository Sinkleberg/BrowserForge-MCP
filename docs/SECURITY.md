# Security

## Threat model

| Threat | Mitigation |
|---|---|
| A web page controls the browser through the agent (prompt injection) | All page-derived tool output is wrapped `{untrustedWebContent:true, notice, data}`; server instructions tell the agent to treat it as data; consequential actions need a human click that the agent cannot answer; there is **no** "evaluate arbitrary JS" tool. |
| A web page attacks the local server (CSRF, DNS rebinding) | Binds to `127.0.0.1` only; `Host` must be loopback; **any request with an `Origin` header is refused** (CLI MCP clients never send one; web pages always do); no CORS headers, `OPTIONS` refused; bearer token required for `/mcp` and `/status`. |
| Another local program drives the browser | Two independent 256-bit tokens, generated with `crypto.randomBytes`, stored `0600` in `~/.config/browserforge/` (`extension-token`, `mcp-token`), compared with constant-time hashing. Anyone who can read your home directory can already do more damage; there is no protection against a same-user attacker. |
| Another extension connects to the socket | It would need the extension token. Origin is only checked to be *an* extension origin (`moz-extension://` / `chrome-extension://`), **not** pinned to this extension's id — the token is the real gate. |
| Malicious/oversized messages | Zod validation on every frame in both directions, 12 MB frame limit, binary frames rejected, 6 invalid frames closes the socket, ≤10 concurrent unauthenticated sockets, 5 s hello timeout. |
| Secrets leaking to the agent, logs or files | See "Secrets" below. |
| Path traversal / arbitrary file access | Every file path goes through `resolveSafePath`: NUL bytes rejected, symlinks resolved, must lie inside an allowed root. Uploads: `~/.config/browserforge/files`, `~/Documents`, `~/Downloads`, `--allow-dir`. Writes (HAR, OpenAPI, clients): `~/.config/browserforge/exports` + `--allow-dir`. Max upload 10 MB. |
| Command execution | The server never executes page-supplied or tool-supplied commands. The only subprocesses are the fixed validation commands (`python3 -m unittest`, `php -l`, `node --test`, `tsc`) run inside a generated client's directory with a minimal environment. |
| Overwriting user files | Client generation refuses to write over files not created by BrowserForge (marker file `.browserforge-generated`) unless `overwrite:true`. |

## Human approval

Enforced **in the extension** (not in the MCP client):

- Clicking a submit button / a button whose label means submit, buy, pay, order, send, confirm, accept, agree, sign, delete, subscribe, book, transfer, post, publish; ticking a terms/consent checkbox.
- `type`/`fill_field` into a password field; `type` with `submit:true`; `Enter` inside a form **or a rich-text editor / `role=textbox`** (Enter usually sends a chat message; Shift+Enter does not ask).
- `fill_form` with `files` (uploads) or `submit:true`.
- Workflow steps with an `approval` text.

The prompt appears as a badge and in the popup (host, action). The agent receives the result only after the human answers; denial returns `APPROVAL_DENIED`; no answer within 2 minutes counts as denial. The approval flag is set by the background script only — page scripts and the agent cannot set it.

**STOP:** the popup's STOP button cancels in-flight work, denies pending approvals and blocks all agent actions. The agent's `browser_resume` is refused (`PERMISSION_DENIED`) while STOP was pressed by the human; only the popup can resume.

Heuristics are not a guarantee: a site can disguise a harmful button as "Show more". Keep the popup visible during sensitive sessions and use STOP freely. The classification errs toward asking.

## Secrets

- **Redaction on output** (`packages/shared/src/redaction.ts`): `Authorization`, `Cookie`, `Set-Cookie`, API-key/token/CSRF headers; query parameters, JSON keys and form fields whose names look sensitive; JWTs; `Bearer …`; well-known key prefixes; URL userinfo. Applied to tool output, HAR export, analysis examples and logs.
- **Reveal** (`reveal:true`, `includeSensitive:true`) is refused unless the operator started the daemon with `--allow-reveal` (or `BROWSERFORGE_ALLOW_REVEAL=1`); each use is logged (without the values).
- **No persistence:** captured traffic lives in memory only; it is written to disk only by an explicit export.
- **Generated code** is scanned before it is written: JWTs, well-known key prefixes, and every credential value found in the source capture are refused (`GENERATION_FAILED`). Clients read credentials from constructor arguments or `<PREFIX>_TOKEN`, `_API_KEY`, `_USERNAME`/`_PASSWORD`, `_COOKIE` environment variables.
- **Logs** go to stderr, drop content-bearing keys (`text, html, body, headers, args, result…`) and redact the rest. Error responses never contain stack traces.
- **Passwords:** form discovery never returns password values; password/credential/declaration/consent/protected-characteristic/salary/work-authorization fields are never auto-filled from profiles.

## Extension privileges

Permissions: `tabs`, `storage`, `scripting`, `webRequest`, `alarms`, and host permission `<all_urls>` (needed for `tabs.captureVisibleTab` screenshots and `webRequest` capture on whatever site you point the agent at). Content scripts are injected only on `http://` and `https://` pages; browser-internal pages are never scripted. **Optional** (requested from the popup, only when you enable the feature): `downloads`; Firefox `webRequestBlocking` + `webRequestFilterResponse` (response bodies); Chrome `debugger` (response bodies, WebSocket frames). Not requested: `cookies`, `history`, `management`, `nativeMessaging`, `webNavigation`, `activeTab`.

The extension talks only to `ws://127.0.0.1` / `ws://localhost` (it refuses any other URL) and sends nothing to any third party. The content script runs in the extension's isolated world; the only main-world script (`page-hook.js`) forwards uncaught-error strings and has no extension privileges.

## Page-context code

BrowserForge never evaluates JavaScript supplied by an agent or a page. Interaction is done with DOM operations (focus, value setters, synthetic input/change events, `click()`) from the isolated content script. If you add an evaluate-style tool, it must show a clear warning and require approval.

## Compliance

Use network capture and API analysis only on sites you are authorised to inspect. The tool does not solve CAPTCHAs, rotate identities, spoof browsers or evade rate limits, and the agent instructions tell it not to. Respect site terms and the law.

## Reporting

This is pre-release software without an external audit. Tests covering the controls above: `tests/security/*`, `tests/unit/shared.test.ts`, `tests/unit/hub.test.ts`, and the approval/untrusted-content cases in `tests/e2e/*`.
