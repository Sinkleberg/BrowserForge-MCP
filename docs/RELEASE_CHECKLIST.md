# Release checklist

- [ ] `npm ci && npm run build`
- [ ] `npm run typecheck` and `npm run lint` clean (lint includes `web-ext lint` on the Firefox build)
- [ ] `npm test` (unit + security + integration) green
- [ ] `npm run test:e2e` green on Firefox **and** Chromium (needs `geckodriver`, Playwright Chromium)
- [ ] Manual smoke on **branded Chrome** (Load unpacked) and **release Firefox** (temporary add-on): connect, `browser_navigate`, form fill, approval prompt, STOP, body-capture permission grants from the popup
- [ ] Approval window: appears on top, chime is audible (Firefox and Chrome), Enter/Esc work, history shows human and YOLO decisions; YOLO badge/banner show and Turn off works; STOP still halts in YOLO
- [ ] `browser_run_goal` against real Ollama on a real site you own; `npm run test:e2e` includes the real-model test only when Ollama and the model are present
- [ ] Plugins: `browserforge plugin add ./examples/plugins/hello` shows the permission list and installs only after you answer yes; `plugin update` re-asks when permissions change; a plugin that asks for more is switched off
- [ ] RenderCV plugin against your real `rendercv` and CVs: `cv_get` -> `cv_tailor` (try inventing a number: it must refuse) -> `cv_render` produces a PDF within the page limit
- [ ] Flows: record a real signup, `flow_export` to Playwright and Selenium, run each with `FLOW_CONFIRM=1` against a site you own
- [ ] Publishing: the SDK (`@browserforge/plugin-sdk` and the packages it depends on) is on npm before advertising `plugin new`; keywords and repository URL are set
- [ ] Idle test: leave both browsers connected ≥ 30 min; tools still work
- [ ] `claude mcp list` / `codex mcp list` show the server; one real tool call from each
- [ ] `npm run package`; inspect `artifacts/*.zip`: no `e2e-config.json`, `manifest.json` has no `web_accessible_resources`, permissions as in `docs/SECURITY.md`
- [ ] Firefox: submit the unlisted build to AMO for signing (`web-ext sign`) if a permanent install is required
- [ ] Grep the tree and the zips for secrets: `rg -n "eyJ|sk-|Bearer [A-Za-z0-9]" --glob '!tests/**'`
- [ ] Update version in the root `package.json`, `apps/*/package.json`, `SERVER_VERSION` in `apps/mcp-server/src/context.ts`, `EXT_VERSION` in `apps/firefox-extension/src/background.ts`
- [ ] Re-read `docs/LIMITATIONS.md` and `docs/SECURITY.md` for anything that changed
- [ ] Tag the release; attach the zips
- [ ] Store uploads use the `*-store-*.zip` files (no manifest `key`); listing text and permission justifications are in [STORE_LISTING.md](STORE_LISTING.md), the privacy policy in [PRIVACY.md](PRIVACY.md)

## Building and checking the package

1. `npm run build && npm run typecheck && npm run lint && npm test` (and `npm run test:e2e` on Linux).
2. `npm run release`: bundles the program into one file, copies the built extensions, writes `release/browserforge-mcp-<version>.tgz` and the store zips in `artifacts/`.
3. `npm run smoke:install -- release`: installs that tarball into a clean folder and checks `--help`, `setup`, the extension folders, that the server starts, `/health` answers and `/status` refuses a missing token. CI runs the same on Ubuntu, Windows and macOS (Actions > CI).
4. Look inside the tarball (`tar -tzf release/*.tgz`): it must contain no personal files, tokens or logs.

Publishing is yours to do with your own accounts (nothing here publishes): `npm publish release/<the .tgz> --access public` (the package is [`@el-makina-ai/browserforge-mcp`](https://www.npmjs.com/package/@el-makina-ai/browserforge-mcp); the unscoped name `browserforge-mcp` is not used), the extension zips to the Chrome Web Store and to addons.mozilla.org (which signs the Firefox build), then update INSTALL.md to say so.
