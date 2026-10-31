# Installation

* **[From the package](#install-from-the-package-any-system)**: for trying BrowserForge on Linux, macOS or Windows. No build step.
* **[From source on Ubuntu](#1-build)**: for developing it (the rest of this page).

## Install from the package (any system)

You need [Node.js 22 or newer](https://nodejs.org) and Chrome, Edge, Brave or Firefox.

```bash
# the package is a single tarball built by `npm run release` (see docs/RELEASE_CHECKLIST.md); once published: npm install -g browserforge-mcp
npm install -g ./browserforge-mcp-0.1.0.tgz
browserforge setup
```

`browserforge setup` prints the next steps with **your** folders and token filled in: where to load the extension in your browser, what to type in its popup, and the command that connects Claude Code. In short:

1. **Start the server and keep it running:** `browserforge serve`.
2. **Load the extension.** Chrome, Edge or Brave: open `chrome://extensions` (or `edge://extensions`), switch on *Developer mode*, *Load unpacked*, and choose the folder `browserforge extension chrome` prints (`chrome-bodies` if you want response bodies captured; see below). Firefox: `about:debugging#/runtime/this-firefox`, *Load Temporary Add-on*, and choose `manifest.json` inside the folder `browserforge extension firefox` prints. Firefox removes temporary add-ons when it restarts; a permanent install needs a signed build (see "Firefox" below).
3. **Connect the extension:** click its icon, enter `ws://127.0.0.1:7345/ext` and the token from `browserforge setup`, press *Connect*.
4. **Connect your AI client**, for example `claude mcp add --transport http browserforge http://127.0.0.1:7345/mcp --header "Authorization: Bearer <token>"` (`browserforge print-config claude` prints it for your shell).
5. **Check:** `browserforge doctor`.

### Where files go

| System | Settings, tokens, logs, flows, knowledge |
|---|---|
| Linux, macOS | `~/.config/browserforge/` (or `$XDG_CONFIG_HOME/browserforge`) |
| Windows | `%APPDATA%\browserforge\` |

Set `BROWSERFORGE_HOME` to put them somewhere else. On Linux and macOS the folders are private to your user (mode 0700, files 0600). **Windows does not enforce those modes**: the folder is protected by your user profile's permissions, so do not move it to a shared drive.

### Windows and macOS: what is and is not known

The package is plain JavaScript and the install steps are the same everywhere, and the project's CI installs the package and starts the server on Ubuntu, Windows and macOS. **Everything here has been run only on Linux by the author.** The Windows and macOS CI runs are informational until they have been green for a while. Known differences:

* Plugins that run programs (RenderCV) need the program's full path in the plugin settings, for example `C:\Users\you\rendercv\.venv\Scripts\rendercv.exe`. `.cmd` and `.bat` files cannot be started this way.
* `browserforge plugin add` runs npm for you; on Windows it uses the npm that comes with your Node.js.
* Chrome shows a "Disable developer mode extensions" notice on Windows after each restart; choose *Keep*. Branded Chrome 137 and newer ignores the `--load-extension` command-line flag, so always use *Load unpacked*.
* Quote the token in PowerShell as `browserforge print-config claude` shows it.

## Install from source (Ubuntu / Linux)

Tested on Ubuntu with Node 24.7, Firefox 158 (snap), Chromium 156 (Playwright build). Other Linux distributions should work; macOS/Windows have not been tested.

## 1. Build

```bash
git clone <this repo> browserforge && cd browserforge     # or use your existing checkout
node -v            # >= 20 (24 tested)
npm install
npm run build      # compiles packages + server, builds dist/firefox and dist/chrome
npm run package    # optional: artifacts/browserforge-firefox-0.1.0.zip and -chrome-0.1.0.zip
```

Optional tools used only by the test-suite and generated-client checks: `python3` (≥3.8), `php` (≥8.1, CLI), a Playwright Chromium (`npx playwright install chromium`), `geckodriver` (for Firefox end-to-end tests).

## 2. Start the daemon

```bash
node apps/mcp-server/dist/cli.js serve            # default port 7345
# or, after `npm link -w @browserforge/mcp-server`:  browserforge serve
```

It prints the endpoints and creates two secrets in `~/.config/browserforge/` (mode 0600): `extension-token` (for the browser extension) and `mcp-token` (for Codex/Claude Code). Show the extension token with:

```bash
node apps/mcp-server/dist/cli.js tokens
```

Options: `--port N`, `--allow-dir DIR` (extra folder for CV uploads / exports; repeatable), `--allow-reveal` (lets tools return unredacted secrets for authorised debugging — leave off normally). Environment: `BROWSERFORGE_PORT`, `BROWSERFORGE_HOME`, `BROWSERFORGE_LOG=debug`.

Run it at login with systemd (user unit):

```ini
# ~/.config/systemd/user/browserforge.service
[Service]
ExecStart=/usr/bin/node /path/to/browserforge/apps/mcp-server/dist/cli.js serve
Restart=on-failure
[Install]
WantedBy=default.target
```
`systemctl --user enable --now browserforge`

## 3. Load the extension

### Firefox (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Select `apps/firefox-extension/dist/firefox/manifest.json` (or the packaged zip).
3. Click the toolbar icon. Paste the **extension token**, keep the server URL `ws://127.0.0.1:7345/ext`, press **Connect**. The dot turns green.

Firefox forgets temporary add-ons on restart. For a permanent install use one of: sign it as an *unlisted* add-on on addons.mozilla.org (`npx web-ext sign --channel unlisted` needs AMO API keys), or run Firefox Developer Edition / Nightly / ESR with `xpinstall.signatures.required = false`. Release-channel and the Ubuntu **snap** Firefox cannot install unsigned add-ons permanently. Minimum Firefox: 140.

### Chrome / Chromium

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → `apps/firefox-extension/dist/chrome`.
2. Open the popup, paste the extension token, **Connect**.

The Chrome build pins a public key, so its extension id is always `omjlkhmfagboopakfflhapniolpfbogp`. Minimum Chrome: 116.

#### Response bodies in Chrome (optional)

Capturing **response bodies** (so `api_analyze_traffic` can describe what an API returns) needs Chrome's `debugger` permission. Chrome does not allow that permission to be optional, so it cannot be granted from the popup the way Firefox's can. Instead there is a second build:

1. Remove the normal one at `chrome://extensions` (both builds share the same extension id, so only one can be loaded), or just use **Load unpacked** on the other folder after removing it.
2. **Load unpacked** `apps/firefox-extension/dist/chrome-bodies`.
3. Reconnect (token as before), open **Network capture** in the popup and tick **Capture response bodies**.

While a tab is captured, Chrome shows a "BrowserForge started debugging this browser" banner on it. That is Chrome's own warning and cannot be hidden. If you do not need bodies, stay on the normal `dist/chrome` build, which does not hold the permission at all. Request metadata (URLs, methods, status, headers, timing) is captured in both builds.

> Automated installation (`--load-extension`) is disabled in branded Chrome ≥ 137; the manual route above works. Automated tests use Playwright's Chromium.

### Optional permissions

In the popup: **Grant body permission…** enables response-body capture (Firefox: `webRequestBlocking` + `webRequestFilterResponse`; Chrome: `debugger`, which makes Chrome show its own debugging banner). **Allow download list…** enables `browser_get_downloads`. Both are off until you click them.

## 4. Connect an agent

- Codex → `docs/CODEX.md`
- Claude Code → `docs/CLAUDE_CODE.md`

Then ask the agent to call `system_status`; it should list your browser as connected.

## 5. Verify the install

```bash
npm test               # unit + security + integration (no browser needed)
npm run test:e2e       # real Firefox and Chromium (needs geckodriver + Playwright Chromium)
BF_BROWSERS=firefox npm run test:e2e     # one browser only
```
