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

Logs: the daemon logs JSON lines to stderr (`BROWSERFORGE_LOG=debug` for more). Logs never contain page text, headers, request/response bodies or tool arguments. The extension log is the **Activity** list in the popup.
