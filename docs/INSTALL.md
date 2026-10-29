# Installation (Ubuntu / Linux)

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
