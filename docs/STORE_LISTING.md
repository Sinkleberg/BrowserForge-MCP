# Store listings

The text submitted to addons.mozilla.org (AMO) and the Chrome Web Store, kept here so every release uses the same wording. Privacy policy for both stores: https://github.com/zoghlamimostafa/BrowserForge-MCP/blob/main/docs/PRIVACY.md

## Upload files

`npm run package` writes them to `artifacts/`:

| Store | File | Notes |
|---|---|---|
| AMO | `browserforge-firefox-<version>.zip` | Plus the source zip: `git archive --format zip -o browserforge-source-<version>.zip v<version>` |
| Chrome Web Store, "BrowserForge" | `browserforge-chrome-store-<version>.zip` | Same as `chrome`, without the manifest `key` (the store refuses it) |
| Chrome Web Store, "BrowserForge (response bodies)" | `browserforge-chrome-bodies-store-<version>.zip` | Holds the `debugger` permission |

## Common text

**Name:** BrowserForge (Chrome bodies build: BrowserForge (response bodies))

**Summary (≤132 characters):** Lets your AI agent (Claude Code, Codex, any MCP client) use this browser, with your approval. Talks only to 127.0.0.1.

**Category:** Developer Tools

**License:** MIT. **Homepage / support:** https://github.com/zoghlamimostafa/BrowserForge-MCP

**Description:**

> BrowserForge connects an AI agent on your computer to this browser. Install the free `browserforge-mcp` program (`npm install -g browserforge-mcp`, then `browserforge setup`), add it to Claude Code, OpenAI Codex or any MCP client, and the agent can open pages, read them, click, type, fill forms and capture network traffic in your real browser session.
>
> You stay in charge:
> • Submitting, sending, paying, uploading and typing passwords wait for your click in a small approval window. The agent cannot answer it.
> • A red STOP button halts every agent action until you resume.
> • Every decision is kept in an approval history you can export.
>
> Local only: the extension talks to the BrowserForge program on 127.0.0.1 and refuses any other address. There are no BrowserForge servers, accounts or telemetry. Secrets (cookies, authorization headers, tokens) are masked before anything reaches the agent.
>
> For developers: capture a site's traffic and get its endpoints, an OpenAPI 3.1 spec and ready-to-use API clients; record what the agent did as a replayable flow and export it to Playwright, Selenium or Chrome Recorder.
>
> Open source (MIT): https://github.com/zoghlamimostafa/BrowserForge-MCP

Chrome bodies build: append

> This build also captures response bodies and WebSocket frames. Chrome only allows that through the "debugger" permission, so Chrome shows a "BrowserForge started debugging this browser" banner on tabs being captured. If you don't need response bodies, install the normal "BrowserForge" item instead.

## Chrome Web Store privacy tab

**Single purpose:** Let an AI agent running on the user's own computer operate and inspect this browser, with human approval for consequential actions.

**Permission justifications:**

| Permission | Why |
|---|---|
| `tabs` | List, open, switch and close the tabs the agent works on, and take screenshots of the visible tab when asked. |
| `storage` | Save the extension's settings, the connection token for the local program, and the approval history. |
| `scripting` | Inject the extension's own content script into tabs opened before the extension started and into iframes (job-application forms often live in one), so the agent can read and act on them. |
| `webRequest` | Record the network requests of tabs the user is capturing, to show and document a site's HTTP API. |
| `alarms` | Keep the connection to the local program alive and reconnect when the service worker restarts. |
| `downloads` (optional) | Asked from the popup only when the user turns on download tracking, so the agent can find files the page downloaded. |
| `debugger` (bodies build only) | Read response bodies and WebSocket frames of captured tabs; Chrome offers no other way to get them. |
| Host permission `<all_urls>` | The agent works on whatever site the user points it at; also required for `captureVisibleTab` and `webRequest` on those sites. |

**Remote code:** No. All code is in the package; nothing is downloaded or evaluated.

**Data usage:** The extension handles website content, web history (addresses of pages the agent visits) and user activity (when "Record me" is on). Tick only those. Certify: not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending. Data goes only to the user's own computer (127.0.0.1), see the privacy policy.

## AMO notes for reviewers

> BrowserForge is the browser half of an open-source MCP server (https://github.com/zoghlamimostafa/BrowserForge-MCP). It connects only to `ws://127.0.0.1` / `ws://localhost` (see `src/background.ts`, the URL is checked before connecting) and authenticates with a token the local program generates. It evaluates no remote or agent-supplied code; page interaction is plain DOM operations from the content script.
>
> The JavaScript is bundled (not minified) with esbuild. To rebuild from the attached source zip: Node 22, then `npm ci && npm run build -w @browserforge/extension`; the add-on is `apps/firefox-extension/dist/firefox/`.
>
> To try it: `npm ci && npm run build && node apps/mcp-server/dist/cli.js serve`, paste the extension token it prints into the popup, then call tools from any MCP client.
