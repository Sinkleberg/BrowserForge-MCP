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
- `browser_close_tab` on a tab the agent did not open itself (tabs it opened with `newTab` close without asking).

The prompt opens in a small **approval window** (brought to the front, with a chime that can be turned off in the popup; Enter approves the first request, Esc denies it) and as a badge on the toolbar button. Every decision (approved, denied, timed out, cancelled) is saved in the popup's **Approval history** (last 1000, exportable as JSON, clearable). The agent receives the result only after the human answers; denial returns `APPROVAL_DENIED`; no answer within 2 minutes counts as denial. The approval flag is set by the background script only — page scripts and the agent cannot set it.

### YOLO mode

An optional switch in the popup (**Approvals → YOLO**) that makes every approval pass automatically, for every agent connected to that browser, including passwords, uploads, submits and sends. It is **off by default**, **per browser**, and stays on until you turn it off.

- Only a human can change it: the setting is written only from the extension's own popup page. The agent protocol, the server and web pages have no way to set it, and the generic `saveSettings` message ignores it, so a prompt-injected page cannot switch the gate off.
- It is loud: the toolbar badge shows red `YOLO`, the popup shows a banner with a one-click Turn off, and `system_diagnostics` reports `approval-mode` as not ok.
- It is still logged: every auto-approval appears in the approval history as `auto (YOLO)`.
- STOP and Pause still work and still win.
- Treat it like leaving your laptop unlocked: any page that manages to steer the agent can then submit forms and send messages as you. Use it on a dedicated browser profile, not your everyday one.

**STOP:** the popup's STOP button cancels in-flight work, denies pending approvals and blocks all agent actions. The agent's `browser_resume` is refused (`PERMISSION_DENIED`) while STOP was pressed by the human; only the popup can resume.

Heuristics are not a guarantee: a site can disguise a harmful button as "Show more". Keep the popup visible during sensitive sessions and use STOP freely. The classification errs toward asking.

## Local decider (`browser_run_goal`)

`browser_run_goal` lets small models on this machine choose routine steps: by default Laya (via Ollaya, `127.0.0.1:11435`) first and Qwen (via Ollama, `127.0.0.1:11434`) when Laya is unsure. Page control labels and headings are sent to them, so **both** URLs must be loopback (`127.0.0.1`, `localhost` or `::1`); anything else is refused at startup. Laya only answers typed choice questions (action, which control, which input key), so it cannot produce free text either. The model's reply is constrained by a JSON schema to a row that exists on the page, one of the operations (no navigation, no free text) and one of the input keys the caller supplied. Input **values** are never put in a prompt or a trace. Every step it takes goes through the same approval gate (or YOLO) as any other action.

Recorded traces (`<config>/knowledge/traces.jsonl`) contain control labels (emails and long numbers are masked), the decision and whether it worked, never input values, never page text. Disable with `--no-traces`; old traces are deleted after `--trace-retention-days` (default 90). Indexed reference documents stay local and are only readable from allowed upload directories.

## Plugins, skills and flows

* **Plugins are code that runs on this computer with your user rights.** What is enforced: they receive a `PluginApi` whose file access is limited to declared folders (symlink-safe), whose programs are limited to declared ones (no shell, minimal environment), and whose browser calls go through the normal actions and the extension's approval gate. You see the permissions in plain words at install and must approve them; a version that asks for different permissions is switched off until you approve again; installs run with `--ignore-scripts`. What is **not** enforced: a plugin that imports `node:fs` itself is not stopped by the API. Install only plugins from authors you trust. Process isolation is future work. Details: [PLUGINS.md](PLUGINS.md).
* **Skills are text for your agent**, written by someone else. They cannot run code or bypass approvals, but they can steer an agent: `skill add` prints the instructions before installing, and the server labels skill text as "written by the skill's author, not by the user". Tool names, descriptions and instructions from plugins are likewise the plugin author's words; core safety rules come first in the server instructions and always win.
* **Flows** are saved under `<config>/flows` (private files). They contain page addresses (session tokens removed), element descriptions (labels, ids) and harmless short answers as parameter defaults; personal values you typed (name, e-mail, phone, birth date, address, links, free text) are stored as parameters without a value unless you set `BROWSERFORGE_FLOW_VALUES=1`, and passwords and sensitive-looking fields are never recorded. `flow_prune` scrubs older recordings. Turn recording off with `--no-flows`. Exported scripts embed values only when you ask, never sensitive ones, and stop before consequential steps unless `FLOW_CONFIRM=1`.

## Secrets

- **Redaction on output** (`packages/shared/src/redaction.ts`): `Authorization`, `Cookie`, `Set-Cookie`, API-key/token/CSRF headers; query parameters, JSON keys and form fields whose names look sensitive; JWTs; `Bearer …`; well-known key prefixes; URL userinfo. Applied to tool output, HAR export, analysis examples and logs.
- **Reveal** (`reveal:true`, `includeSensitive:true`) is refused unless the operator started the daemon with `--allow-reveal` (or `BROWSERFORGE_ALLOW_REVEAL=1`); each use is logged (without the values).
- **No persistence:** captured traffic lives in memory only; it is written to disk only by an explicit export.
- **Generated code** is scanned before it is written: JWTs, well-known key prefixes, and every credential value found in the source capture are refused (`GENERATION_FAILED`). Clients read credentials from constructor arguments or `<PREFIX>_TOKEN`, `_API_KEY`, `_USERNAME`/`_PASSWORD`, `_COOKIE` environment variables.
- **Logs** go to stderr, drop content-bearing keys (`text, html, body, headers, args, result…`) and redact the rest. Error responses never contain stack traces.
- **Passwords:** form discovery never returns password values; password/credential/declaration/consent/protected-characteristic/salary/work-authorization fields are never auto-filled from profiles.

## Extension privileges

Permissions: `tabs`, `storage`, `scripting`, `webRequest`, `alarms`, and host permission `<all_urls>` (needed for `tabs.captureVisibleTab` screenshots and `webRequest` capture on whatever site you point the agent at). Content scripts are injected only on `http://` and `https://` pages; browser-internal pages are never scripted. **Optional** (requested from the popup, only when you enable the feature): `downloads`; Firefox `webRequestBlocking` + `webRequestFilterResponse` (response bodies). **Chrome does not allow `debugger` to be optional**, so response bodies and WebSocket frames in Chrome need a separate build, `dist/chrome-bodies`, where `debugger` is a required permission (Chrome shows a "debugging this browser" banner on captured tabs); the normal `dist/chrome` build does not hold it. Not requested: `cookies`, `history`, `management`, `nativeMessaging`, `webNavigation`, `activeTab`.

The extension talks only to `ws://127.0.0.1` / `ws://localhost` (it refuses any other URL) and sends nothing to any third party. The content script runs in the extension's isolated world; the only main-world script (`page-hook.js`) forwards uncaught-error strings and has no extension privileges.

## Page-context code

BrowserForge never evaluates JavaScript supplied by an agent or a page. Interaction is done with DOM operations (focus, value setters, synthetic input/change events, `click()`) from the isolated content script. If you add an evaluate-style tool, it must show a clear warning and require approval.

## Compliance

Use network capture and API analysis only on sites you are authorised to inspect. BrowserForge does not rotate identities, spoof browsers or evade rate limits. Optional CAPTCHA solving with a local CapSkip app is available (see below) but is off by default and gated behind YOLO mode — use it only on sites you are authorised to automate. Respect site terms and the law.

## CAPTCHA solving (optional, off by default)

`browser_solve_captcha` hands reCAPTCHA v2/v3 (including invisible and Enterprise) and Cloudflare Turnstile to [CapSkip](https://github.com/capskip/capskip-mcp), a desktop solver that runs on your own computer. hCaptcha is not supported. It needs both of these, and refuses with `PERMISSION_DENIED` otherwise:

- **Server switch**: start the daemon with `--capskip` (or `CAPSKIP_ENABLED=1`). Options: `--capskip-url` (default `http://127.0.0.1:8080`, or `CAPSKIP_HOST` / `CAPSKIP_PORT`), `--capskip-api-key` / `CAPSKIP_API_KEY` (any string when CapSkip's key check is off), `--capskip-timeout` / `CAPSKIP_TIMEOUT` seconds (default 300).
- **YOLO mode** on in the extension popup. Only the human can set it; the agent, the server and web pages cannot.

What it does and does not do:

- **Loopback only.** The CapSkip URL must be `127.0.0.1`, `localhost` or `::1`, or the server refuses to start: the page address and the public site key are sent to it, like the local decider. Nothing goes to a third-party solving service.
- The extension's read-only `captcha_scan` action lists the widgets on the top page (type and public site key). It does not click anything. CAPTCHAs inside iframes other than the standard reCAPTCHA frame, image CAPTCHAs, GeeTest, CaptchaFox, Friendly Captcha, ALTCHA and Capy are not detected.
- The tool returns the token and the field it belongs in; the agent places it with `browser_fill_field`. Nothing is injected for it, and the form submit still goes through the approval gate (which YOLO passes). For Turnstile the token is bound to the User-Agent CapSkip returns.
- The API key is never written to logs or traces. Solves are logged by type and duration only.

**Solving by looking (no CapSkip).** The agent instructions also let the agent solve a CAPTCHA itself when YOLO mode is on or you tell it to: it clicks the checkbox inside the CAPTCHA iframe, takes one screenshot of the image challenge, clicks the matching tiles and presses Verify, giving up after 3 rounds. This uses only the ordinary click and screenshot tools (the screenshot goes to your AI client, as any screenshot does), so there is no server-side gate beyond the instructions; the YOLO condition is guidance, not enforcement.

Solving a CAPTCHA defeats a check the site put there to stop automation. Use it only on sites you are authorised to automate, on a dedicated browser profile, and treat it like YOLO itself.

## Reporting

This is pre-release software without an external audit. Tests covering the controls above: `tests/security/*`, `tests/unit/shared.test.ts`, `tests/unit/hub.test.ts`, and the approval/untrusted-content cases in `tests/e2e/*`.

## The log file

`~/.config/browserforge/logs/` (mode 0700, files 0600) holds the server's log: tool calls, browser actions, errors and the extension's activity timeline. It goes through the same redaction as terminal logs: typed values, page text, HTML, headers, cookies, bodies, screenshots, tool arguments and results are dropped, secrets in strings are masked and long strings cut at 300 characters. It still shows *what you did and when* (sites visited by host, which tools ran), so treat it as private: review `browserforge diagnostics` output before pasting it in a public issue. Retention is 14 days (`--log-retention-days`), `--no-log-file` turns it off.

## Record me (recording your own actions)

An opt-in switch in the extension popup, **off by default** and never active in private windows. While on, the page script notes the elements you click, select and fill, and sends a description (the element's locators, its label, the page address and the page's control rows) to the local server. It does **not** send page text.

* A typed value is sent only if you also turn on "Also keep the text I type", and **never** for password-like fields (password type, `autocomplete` of card or one-time-code, or a name, id, placeholder or label that looks like a password, card number, CVV, IBAN, SSN, OTP, token, secret or PIN). The extension and the server both enforce this; the value never reaches the flow, the traces or the log.
* Only trusted events count: BrowserForge's own tools produce synthetic events, which are ignored.
* The extension limits the rate (25 events a second) and clamps every field to the protocol's limits before sending; the server drops a browser that sends many malformed messages.
* Data goes to `<config>/flows/` and `<config>/knowledge/` on your computer, private (0600), and nowhere else. Control rows in training examples have emails and phone-like numbers scrubbed from their labels.
* What it still reveals: which sites you visited and what the form fields were called. Treat the folder like your browsing history, and turn the switch off on pages you do not want in it.
