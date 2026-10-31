# Privacy policy

Applies to the BrowserForge browser extension (Firefox, Chrome, and the Chrome "response bodies" build) and the `browserforge-mcp` program. Last updated 2026-11-01.

## Short version

BrowserForge has no servers, no accounts and no telemetry. The extension talks only to the BrowserForge program running on your own computer (`ws://127.0.0.1` / `ws://localhost`) and refuses any other address. We (the authors) never receive any of your data.

## What the extension handles

When an AI agent you connected to BrowserForge asks for it, or when you use the popup, the extension can read or act on:

- the address, title and content of web pages in your tabs (text, form fields, links, buttons, screenshots);
- network requests made by those pages (addresses, headers and, if you switch on body capture, response bodies);
- what you type into forms it fills for you, and the files you choose to upload;
- if you turn on **Record me**, the elements you click and fill (never passwords; typed text only if you also turn that on).

The extension uses this only to carry out the action that was requested and to show you its status. It does not read your cookies store, history or bookmarks, and it does not script browser-internal pages.

## Where the data goes

- **To the BrowserForge program on your computer**, over the loopback connection. That program keeps captured traffic in memory only, and writes files only to its own private folder (`~/.config/browserforge/`, files readable only by you) or to folders you allowed: exports you ask for, recorded flows, site notes, approval history, a redacted log (kept 14 days by default) and model traces (control labels and outcomes, never typed values; kept 90 days by default).
- **To the AI client you connected** (for example Claude Code, Codex or a local model client). Whatever an agent reads through BrowserForge is returned to that client, and from there to whatever model it uses. If that client sends data to a cloud AI service, that service's privacy policy applies to it. BrowserForge masks secrets (authorization headers, cookies, tokens, keys, JWTs) in what it returns, but page text and form contents are passed on as they are.
- **To local models only**, for `browser_run_goal` and optional CAPTCHA solving: these addresses must be on your own computer (`127.0.0.1`, `localhost` or `::1`), or the program refuses to start.
- **Nowhere else.** No analytics, no crash reporting, no advertising, no sale or transfer of data to third parties, and no use of data for credit or lending decisions.

## Your control

- Nothing happens until you install and start the program and connect an AI client.
- Consequential actions (submitting, sending, paying, uploading, typing passwords) wait for your approval in the extension, unless you switch on YOLO mode yourself.
- The popup's STOP button blocks all agent actions.
- You can delete everything BrowserForge stored by removing `~/.config/browserforge/` and uninstalling the extension.

## Contact

Questions or concerns: open an issue at https://github.com/zoghlamimostafa/BrowserForge-MCP/issues (for security issues use https://github.com/zoghlamimostafa/BrowserForge-MCP/security/advisories/new).
