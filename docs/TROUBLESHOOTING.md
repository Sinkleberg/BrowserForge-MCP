# Troubleshooting

Start with: `node apps/mcp-server/dist/cli.js doctor` (needs the daemon running) or the MCP tools `system_status` / `system_diagnostics`.

| Symptom | Cause / fix |
|---|---|
| Popup dot is red, error "Cannot reach server" | Daemon not running or wrong port. `curl http://127.0.0.1:7345/health` should return `{"ok":true,…}`. Start with `browserforge serve`. |
| "Server rejected the token" | Pasted the **MCP** token instead of the **extension** token, or the token file was regenerated. Run `browserforge tokens` and paste the extension token; press Connect. |
| "Server URL must be ws://127.0.0.1:<port>/ext" | Only loopback `ws://` URLs are accepted by design. |
| `system_status` says `connected:false` / tools return `NOT_CONNECTED` | Browser closed, extension not connected, or temporary Firefox add-on was removed on restart (re-load it). The extension reconnects with backoff up to 15 s. |
| `INVALID_ARGUMENTS … Multiple browsers are connected; pass browserId` | Firefox and Chrome are both connected; pass `browserId` from `system_status` on the first call; after that the most recently addressed browser is the default. |
| `UNSUPPORTED … browser-internal page` | The active tab is `about:`/`chrome:`/an add-on store page. Navigate to an http(s) page first. |
| `STALE_REF` | The page navigated or re-rendered. Call `browser_get_interactive_elements` again and use the new refs. |
| `APPROVAL_DENIED` / action hangs | The extension is waiting for a human. Open the popup (the badge shows a number) and Approve or Deny; unanswered prompts are denied after 2 minutes. |
| `STOPPED` / `PERMISSION_DENIED … only the extension popup can resume it` | The human pressed STOP. Press **Resume** in the popup. |
| `PAUSED` | `browser_pause` was called; call `browser_resume`. |
| `network_list_requests` is empty | Capture is per-tab-load: reload the page after connecting; check the popup's "Capture request metadata" is ticked; internal pages are never captured. |
| Response bodies missing | Enable *Capture response bodies* and grant the permission in the popup (see `docs/INSTALL.md`). Only requests made afterwards have bodies. |
| `PERMISSION_DENIED … Revealing redacted values is disabled` | Intentional. Restart the daemon with `--allow-reveal` only for authorised debugging. |
| `PATH_NOT_ALLOWED` | The file is outside the allowed folders. Put CVs in `~/.config/browserforge/files`, `~/Documents` or `~/Downloads`, or start the daemon with `--allow-dir /path`. Exports go to `~/.config/browserforge/exports` unless `--allow-dir` is given. |
| `api_generate_client` → `GENERATION_FAILED … failed validation` | Read the failing check output in the error; typical causes: missing `python3`/`php`/`node`, or the TypeScript toolchain not installed (`checks[].status:"skipped"`). |
| `PERMISSION_DENIED … would overwrite … existing file(s)` | Choose an empty directory, or pass `overwrite:true` if you really mean it. |
| Codex/Claude cannot connect | Wrong token (use the **MCP** token), wrong port, or the daemon is not running. `curl -s -H "Authorization: Bearer $(cat ~/.config/browserforge/mcp-token)" http://127.0.0.1:7345/status` should return JSON. A 403 means a request carried an `Origin` header (browsers/proxies) or a non-loopback `Host`. |
| Port already in use | Another daemon is running (`ss -ltnp | grep 7345`), or pick `--port` and update the extension URL and client configs. `stdio` mode needs the port too. |
| Chrome: "Service worker (inactive)" | Normal; it wakes on the next alarm/ping and reconnects. Open the popup to force a refresh. |
| Firefox snap: cannot read a CV | Snap confinement; copy the file under `~/Documents` or `~/.config/browserforge/files`. |
| Tests: `Executable doesn't exist … chromium` | `npx playwright install chromium`, or set `BF_CHROMIUM=/path/to/chrome`. Firefox tests need `geckodriver` on the PATH or in `/snap/bin`. |

## Logs: finding what went wrong

The server saves a log of everything it does, so a bug can be looked at after it happened.

- **Where:** `~/.config/browserforge/logs/server-YYYY-MM-DD.log` (JSON lines, one file per day, a new `.1`, `.2` file past 20 MB). Files are private (0600) and ones older than 14 days are deleted.
- **What is in it:** server start/stop, every tool call (name, browser, tab, time, and the error code and message if it failed), every browser action the server sent (action, time, outcome), warnings from the browser (`browser error`), the extension's own timeline (clicks, navigation, approvals, YOLO on/off, STOP; short summaries with the host and element ref), plugin and flow loading, and the local model's decisions in `browser_run_goal`.
- **What is never in it:** typed values, page text, HTML, headers, cookies, request bodies, tool arguments, passwords or tokens. Long strings are cut at 300 characters.
- **Read it:** `browserforge logs --tail 100 --level warn --since 2h` (`--level debug|info|warn|error`, `--since 30m|2h|1d`). `system_diagnostics` also shows where the file is.
- **What it costs the model:** every `tool ok` line has `chars`, `approxTokens` (about 4 characters per token) and `imageBytes` for screenshots, so you can see which calls fill Claude's context. `browserforge diagnostics` ranks tools by it. This is an estimate of what each reply adds; the real token count and bill come from your Claude client, which the server cannot see.
- **Report a bug:** `browserforge diagnostics` prints a short report (versions, settings, the warnings and errors of the last day) that is safe to paste into an issue.
- **Terminal output** is unchanged: it only shows `BROWSERFORGE_LOG` level and above (default `info`); the file always gets `debug` too.
- **Turn it off or shorten it:** `--no-log-file` (or `BROWSERFORGE_NO_LOG_FILE=1`), `--log-retention-days N`.
- **The extension's timeline** (Activity in the popup) is saved in the browser (last 1000 items), so it survives a browser restart. "Clear" in the popup erases it.

The daemon also logs JSON lines to stderr (`BROWSERFORGE_LOG=debug` for more). Logs never contain page text, headers, request/response bodies or tool arguments. The extension log is the **Activity** list in the popup.
