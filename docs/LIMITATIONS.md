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

- **Chrome response bodies need a separate build.** Chrome rejects `debugger` as an optional permission, so the "Capture response bodies" switch only works in `dist/chrome-bodies` (see [INSTALL.md](INSTALL.md)). In the normal Chrome build the switch is disabled and says so. Firefox can grant its body permissions from the popup.

## Browser automation

- **Agent window** is off by default. When on, it relies on the browser letting an extension open a window without focus; headless Firefox and Chromium both did in the tests, but window managers differ and a minimised agent window can make screenshots of it fail. A page that opens a new tab from an agent tab joins the agent's tabs; a popup window the page opens (`window.open` with a size) is a separate window and is not tracked.
- **Tables** are found only as HTML `<table>` and ARIA `table`/`grid` elements, as text. Lists and cards built from `div`s are not tables; closed shadow roots and virtualised grids (that only draw the rows on screen) return only what is drawn. Layout tables with one row or one column are skipped on purpose, so a genuine one-column table is too.

- Only `http(s)` pages. `about:`, `file:`, `data:`, `javascript:`, extension pages, AMO and the Chrome Web Store cannot be scripted or navigated to by the agent.
- **Iframes** (same-origin and cross-origin) are read and driven: `browser_get_interactive_elements`, `browser_get_forms` and `browser_get_page_text` include up to 12 child frames (pass `includeFrames:false` to skip them), their rows are numbered as one list, and a ref from a frame is routed to that frame automatically. Limits: a call without a ref or selector (`browser_type` into the focused field, `browser_press_key`) acts on the top frame only, so click or target the field by ref first; frames the browser will not script (sandboxed, `file:`, extension pages) are skipped; frames beyond the twelfth are ignored; nested frames are listed but each frame's `inViewport` is measured inside that frame. **Open shadow roots** (for example SmartRecruiters' `spl-*` components) are read and driven; recorded locators for elements inside them cannot yet be replayed. **Closed shadow roots** are still invisible.
- `browser_get_console_errors` returns uncaught exceptions and unhandled rejections only; extensions cannot read `console.*` output without DevTools.
- Typing is simulated with synthetic events. `<input>`/`<textarea>` get per-character key and input events. **Rich-text editors** (`contenteditable`, `role=textbox`: Lexical, Draft.js, Slate, ProseMirror, plain divs) receive the whole text in one call as a cancelable `beforeinput` (which model-driven editors handle), falling back to native `execCommand`, a synthetic paste, then direct DOM insertion; newlines become soft line breaks, never Enter. This is tested against a model-driven demo editor on Firefox and Chromium, **not against real sites** (e.g. Instagram, Slack, Gmail), and editors or canvas apps that require `isTrusted` input events will refuse it with `UNSUPPORTED` (a possible future fallback is Chrome's `debugger` `Input.insertText`). Native `<input type=file>` can be filled; drag-and-drop uploaders and OS file dialogs cannot.
- Full-page screenshots are stitched viewport captures (rate-limited to ~2/s by browsers) and capped at 12 000 CSS px; sticky headers may repeat.
- Consequential-action detection is heuristic (labels/types). It judges the whole enclosing control: its text, `aria-label`, `title`, `aria-labelledby` and labelled children such as `<svg aria-label="Send">`. A cleverly disguised button (an icon with no label anywhere, "Show more") may still not trigger an approval prompt.
- YOLO mode disables the approval gate entirely for that browser (see `docs/SECURITY.md`).
- 2FA and logins are for the human; the tool offers no way to bypass them. CAPTCHAs are for the human too, unless you opt in to `browser_solve_captcha` (reCAPTCHA v2/v3 and Turnstile only, through a local CapSkip app, with YOLO mode on): hCaptcha, image CAPTCHAs and widgets inside unusual iframes are still yours to solve.
- The Chrome service worker can be suspended; BrowserForge reconnects automatically, but in-flight long actions may need a retry.

## Local decider, memory and fine-tuning data

- `browser_run_goal` needs a running Ollama with the model pulled (default `qwen3:4b-instruct`, about 2.5 GB). The first call after the model was idle loads it into memory and can take 20 to 60 s; later steps take about 1 s on a 4 GB GPU. In our tests `qwen2.5:3b-instruct` often picked impossible steps and `qwen3:4b-instruct` did not, so treat small models as unproven on sites other than the demo form (every run on the demo signup form succeeded: 5 repeats x 2 browsers x 4 runs; nothing measured on real sites).
- **Laya is not the default.** Measured on 2026-10-29 with the five states of the demo signup form (empty, partly filled, all filled, submitted): `laya:en` got 1 of 5 next steps right (it answered DONE on the empty form, confidence 0.77), Ollaya's `decider:0.8b` also 1 of 5 (about 2 s per step), while `qwen3:4b-instruct` got every state right at about 0.7 s on the 4 GB GPU. Laya is a triage/guardrail classifier and its context is tiny (about 512 tokens), so it only sees a shortlist of up to 30 controls. `--decider cascade` keeps it available: its DONE/BLOCKED are always confirmed by Qwen and unsure picks escalate, but a confidently wrong pick on a valid field (e.g. typing the first name into the wrong text box) would still be executed. Use it only to experiment, or with a better decision model (e.g. OpenJev on a big GPU) behind the same `/v1/systemone` API.
- It sees a table of at most 100 visible controls plus short headings and status text. It does not see screenshots, iframes or closed shadow roots, and it can misjudge when a goal is complete: always verify, then call `browser_goal_feedback`.
- Memory only reuses a step after the identical situation (same site, page type, goal, controls and page cues) succeeded three times and was not labelled bad; it is keyword (BM25) matching, not semantic search.
- Document ingestion supports `.md .txt .csv .json .html .docx`. **PDF is not supported** (no PDF parser is bundled); export it as text or Word first.
- Exported datasets reproduce the model's prompt without the page headings (they are deliberately not stored) and without the retrieved examples. Fine-tuning on them is untested; see `docs/FINETUNING.md`.

## Flows, plugins and skills

- **Flows** are recorded from what the page reports, so they only know elements BrowserForge could see: no canvas apps, no closed shadow roots, no sandboxed iframes. Locators come from the live page; a redesigned site needs a new recording. Custom dropdowns replay as "open it, click the option with this text", which does not suit every widget library. Exported Selenium and Chrome Recorder files are checked for syntax (and TypeScript against Playwright's types), and the Playwright TypeScript export is run against a demo site in the test suite; Selenium (Python, Java) and the Chrome Recorder file are **not** executed in a browser by the tests.
- **Outcome checks** are keyword matches on the page's headings and alerts (English, Italian, French, Spanish, German), plus the address and whether the form disappeared. A confirmation in another language, or one shown only as an image or in a popup outside the headings, is read as "unknown". A flow or run marked `success` was judged by that heuristic, not by a person.
- **Site cards** are hints from past runs, can be out of date, and notes written by agents are not verified.
- **Record me** sees trusted clicks, selections and typed fields in the page of a tab (and in frames BrowserForge has entered), measured in real Firefox and Chromium on the demo form only. It does not see rich-text editors without a change event, drag and drop or hover menus. A training run with no readable ending gets no automatic label. No model has been fine-tuned on recorded demonstrations yet.
- **Flow merging** aligns steps by shared locators; two recordings of a task that differ a lot (different order, different forms) merge into the longest one with fewer steps, which may then need a look before you share it.
- **Plugins** run in the server process. The permission list is enforced on the plugin API, not on arbitrary code (see [SECURITY.md](SECURITY.md)). `@browserforge/plugin-sdk` is not published to npm yet, so plugins are developed inside a checkout of this repository until it is. Plugins run on Node 22 or newer. A plugin that ships its own copy of `zod` works (tested), but should use the same major version (4).
- **Skills** are advice: the model may follow or ignore them, and they can be wrong. There is no review of community skills; read before you add.
- **RenderCV plugin**: tested against a stand-in `rendercv` that mimics its options, not against every RenderCV version (written for v2.6). Page count is taken from the PNG pages rendercv writes. The no-new-facts check catches numbers, links, tool names, acronyms and mid-sentence names; it cannot judge whether a reworded sentence is still true, so read the diff `cv_tailor` returns.

## Platform and install

- Ubuntu snap Firefox (and Firefox release channel) accepts only temporary unsigned add-ons; permanent install needs AMO signing or Developer Edition/Nightly/ESR.
- Branded Chrome ≥ 137 blocks `--load-extension`; load unpacked manually. Automated tests use Playwright's Chromium, so the **branded Chrome build has not been exercised by the test-suite** (the same code runs in Chromium).
- Snap confinement may block reading CVs outside `$HOME`; keep uploads under the allowed folders.
- **Linux is the only system where BrowserForge has been run.** The program is a single JavaScript file and the code avoids shell commands, `.cmd` launching and POSIX-only paths, and CI runs the tests and an install-and-start check on Windows and macOS, but **nobody has used it on those systems yet**: expect to find problems. Windows does not enforce file modes (see docs/INSTALL.md), cannot start `.cmd` or `.bat` programs from plugins, and has not been used with a real RenderCV. macOS paths are case-insensitive, which the path checks treat as a mismatch (a legitimate path in different letter case may be refused, never allowed wrongly).
- The extension has been submitted to addons.mozilla.org and the Chrome Web Store; until a listing is approved, Chrome, Edge and Brave need "Load unpacked" and Developer mode, and Firefox needs a temporary add-on (removed at restart) unless you use Developer Edition/Nightly or sign it yourself. The program is on npm (`browserforge-mcp`) and as a tarball on GitHub Releases; it is not on Homebrew or winget.
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
