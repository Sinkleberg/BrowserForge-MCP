# Known limitations

BrowserForge reports what a WebExtension can actually see. It does **not** capture "all browser traffic".

## Network capture

| Case | Firefox | Chrome |
|---|---|---|
| Request URL, method, headers, query, timing, tab, initiator | ✔ `webRequest` | ✔ `webRequest` |
| Request bodies (form data / raw) | ✔ (size-capped, text only in practice) | ✔ |
| Response bodies | opt-in, `filterResponseData` (text types only, size-capped, only for requests that start *after* it is enabled) | opt-in, `chrome.debugger` (Chrome shows a banner; only tabs attached after enabling) |
| WebSocket frames | ✘ not observable by extensions | implemented through `chrome.debugger`; **not covered by automated tests** |
| Server-sent events / streaming responses | headers only; bodies truncated or absent | headers; body only after completion |
| Requests made by service workers / other extensions | ✘ / not attributed to a tab | partial |
| Browser-internal pages (`about:`, `chrome:`, add-on stores, PDF viewer) | ✘ | ✘ |
| Cross-origin response bodies | allowed for webRequest filters; opaque to page scripts but not to the filter | via debugger |
| Cached responses (`fromCache`) | recorded without body | recorded without body |
| Header fidelity | some browser-added headers are not exposed | `extraHeaders` used |
| Redirect chains | hops are not recorded separately | one record per hop (debugger path) |

Binary bodies are never stored. Capture stops at 5 000 requests per capture (configurable); the oldest are dropped. Nothing is written to disk unless you export.

## Browser automation

- Only `http(s)` pages. `about:`, `file:`, `data:`, `javascript:`, extension pages, AMO and the Chrome Web Store cannot be scripted or navigated to by the agent.
- Content scripts run in the top frame only: **iframes are not traversed**, closed shadow roots and cross-origin frames are invisible.
- `browser_get_console_errors` returns uncaught exceptions and unhandled rejections only; extensions cannot read `console.*` output without DevTools.
- Typing is simulated with synthetic events. `<input>`/`<textarea>` get per-character key and input events. **Rich-text editors** (`contenteditable`, `role=textbox`: Lexical, Draft.js, Slate, ProseMirror, plain divs) receive the whole text in one call as a cancelable `beforeinput` (which model-driven editors handle), falling back to native `execCommand`, a synthetic paste, then direct DOM insertion; newlines become soft line breaks, never Enter. This is tested against a model-driven demo editor on Firefox and Chromium, **not against real sites** (e.g. Instagram, Slack, Gmail), and editors or canvas apps that require `isTrusted` input events will refuse it with `UNSUPPORTED` (a possible future fallback is Chrome's `debugger` `Input.insertText`). Native `<input type=file>` can be filled; drag-and-drop uploaders and OS file dialogs cannot.
- Full-page screenshots are stitched viewport captures (rate-limited to ~2/s by browsers) and capped at 12 000 CSS px; sticky headers may repeat.
- Consequential-action detection is heuristic (labels/types). A cleverly disguised button may not trigger an approval prompt.
- CAPTCHAs, 2FA and logins are for the human; the tool deliberately offers no way to bypass them.
- The Chrome service worker can be suspended; BrowserForge reconnects automatically, but in-flight long actions may need a retry.

## Platform and install

- Ubuntu snap Firefox (and Firefox release channel) accepts only temporary unsigned add-ons; permanent install needs AMO signing or Developer Edition/Nightly/ESR.
- Branded Chrome ≥ 137 blocks `--load-extension`; load unpacked manually. Automated tests use Playwright's Chromium, so the **branded Chrome build has not been exercised by the test-suite** (the same code runs in Chromium).
- Snap confinement may block reading CVs outside `$HOME`; keep uploads under the allowed folders.
- Linux only has been tested. macOS/Windows are expected to work (pure Node/WebExtension) but are untested.
- Firefox optional permissions (`webRequestBlocking`, `webRequestFilterResponse`, `downloads`) and Chrome's `debugger`/`downloads` are requested by popup buttons. Automated tests use `-e2e` builds with them pre-granted, so **the interactive grant flow was not exercised automatically**.
- The extension was run only for short sessions in tests; long-idle behaviour of the Firefox event page and the Chrome service worker (keep-alive/reconnect) is implemented but not soak-tested.

## API analysis and client generation

- Everything is inferred from the samples you captured. Parameters never seen are unknown; a parameter seen in every sample is only a *hypothesis* of "required". Enum values, numeric ranges, rate limits and server-side validation are not inferred.
- Path templating treats numeric / UUID / `prefix_123`-style / long-hex segments as identifiers; other variable segments (slugs, usernames) stay literal and produce one endpoint per value.
- Response schemas need captured response bodies (enable body capture or import a HAR that has them).
- GraphQL operations are documented and callable from the generated clients but cannot be represented as distinct OpenAPI operations (they share one path+method), so they are listed under `x-browserforge-skipped`.
- Only JSON and form-urlencoded request bodies are parsed. Multipart, protobuf, gRPC-web and binary protocols are not analysed.
- Generated clients target: Python ≥ 3.8 (stdlib only), Node ≥ 18 (global `fetch`; TypeScript needs `typescript` + `@types/node` to build), PHP ≥ 8.1 (streams; no cURL needed). One host per client (the busiest, or `host` argument).
- Authentication is *described* (bearer / basic / API-key header / cookie names) but flows such as OAuth token exchange or signed requests are not reproduced.
- Generated unit tests run against a local stub server; they prove the client behaves as designed, not that it matches the real API for untested inputs.

## Product

- No audit; see `docs/SECURITY.md` for what is and is not defended against.
- No persistent capture storage, no multi-user mode, no remote access by design.
