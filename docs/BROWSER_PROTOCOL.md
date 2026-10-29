# Browser connection protocol (v1)

Transport: WebSocket at `ws://127.0.0.1:<port>/ext`, text frames only, one JSON object per frame, max 12 MB. Source of truth: `packages/browser-protocol/src` (Zod schemas, used by both sides).

## Handshake

1. The extension opens the socket. The server checks the `Host` header (loopback only) and the `Origin` header (must start with `moz-extension://` or `chrome-extension://`; web pages cannot forge this). Anything else gets `403` before the upgrade.
2. First frame **must** be `hello`; the server closes with `4400` otherwise, and with `4408` if nothing arrives within 5 s.

```json
{ "v": 1, "type": "hello", "token": "<256-bit extension token>",
  "browser": { "kind": "firefox|chrome", "version": "158.0", "id": "br-<uuid>" },
  "extension": { "id": "…", "version": "0.1.0" },
  "capabilities": { "networkCapture": true, "responseBodies": true, "webSocketFrames": false,
                    "screenshots": true, "fullPageScreenshots": true, "downloads": true } }
```

3. Wrong token → close code **4401**. Success → `{ "v":1, "type":"hello_ack", "serverVersion":"0.1.0", "sessionId":"…" }`.

`browser.id` is stable per browser profile. Reconnecting with the same id resumes the peer: unanswered requests are re-sent and the extension de-duplicates by request id.

## Messages

Every message has `v` (protocol version, currently `1`) and `type`.

| Direction | `type` | Fields |
|---|---|---|
| server → ext | `request` | `id` (≤100 chars), `action`, `args` (validated), optional `timeoutMs` (soft deadline) |
| ext → server | `response` | `id`, `ok:true`, `result` — or `ok:false`, `error:{code,message,retryable,details?}` |
| server → ext | `cancel` | `id` — abandon a request |
| ext → server | `event` | `event:"network"` (captured exchange) or `event:"activity"` (log line) |
| both | `ping` / `pong` | keep-alive |

Invalid frames are dropped (6 strikes closes the socket). A `response` for an unknown id is ignored.

## Actions

Arguments are validated by the server **and again** by the extension. Unknown arguments are stripped, unknown actions are refused.

| Action | Read-only | Notes |
|---|---|---|
| `tabs_list`, `tabs_active` | ✔ | |
| `tabs_select` | | makes the tab the default target |
| `navigate` | | http(s) only; `history: back/forward/reload`; `newTab` |
| `click`, `type`, `fill_field`, `select_option`, `scroll`, `press_key` | | target by `ref` (preferred) or `selector` |
| `page_text`, `dom_snapshot`, `interactive_elements`, `forms`, `console_errors`, `wait_for_element` | ✔ | content is untrusted |
| `fill_form` | | label/name/id matching; `files[]`, `submit` need approval |
| `screenshot` | ✔ | PNG/JPEG, optional full page |
| `downloads` | ✔ | needs optional `downloads` permission |
| `network_configure` | | capture on/off, bodies, tab filter, size cap |
| `request_approval` | | ask the human to approve a workflow step |
| `stop`, `pause`, `resume`, `status` | | `resume` fails if the **human** pressed STOP |

## Error codes

`INVALID_ARGUMENTS, UNAUTHORIZED, NOT_CONNECTED, TIMEOUT, CANCELLED, TAB_NOT_FOUND, ELEMENT_NOT_FOUND, STALE_REF, NAVIGATION_FAILED, APPROVAL_REQUIRED, APPROVAL_DENIED, PAUSED, STOPPED, UNSUPPORTED, PERMISSION_DENIED, PATH_NOT_ALLOWED, NOT_FOUND, LIMIT_EXCEEDED, GENERATION_FAILED, INTERNAL`.

`retryable:true` means the same request may succeed later (timeouts, disconnects, navigation races).

## Reliability rules

- **Timeouts:** the server enforces a hard deadline (`timeoutMs + 1 s`) and sends `cancel`; the extension enforces `timeoutMs` itself.
- **Duplicates:** the extension answers a repeated request id from its response cache (200 entries) and ignores it while still running.
- **Disconnects:** in-flight requests survive a 5 s grace period for a resume; after that they fail with `NOT_CONNECTED` (retryable).
- **Stale references:** element refs are `<epoch>:<n>`; the epoch changes on every page load.
- **Disconnected tabs:** a closed or missing tab yields `TAB_NOT_FOUND`; a page that changes mid-action yields `NAVIGATION_FAILED` (retryable).
