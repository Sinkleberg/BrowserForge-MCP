# Flows: every site you work on, saved and exportable

BrowserForge records what an agent does on each website as a **flow**: the steps, several ways to find each element, and the values you typed as named parameters. A flow can be replayed without any model, or exported to a script for Playwright, Selenium or Chrome DevTools Recorder, or to a neutral JSON file for anything else.

Recording is automatic. Switch it off with `browserforge serve --no-flows` or `BROWSERFORGE_NO_FLOWS=1`, or at run time with `flow_record {on:false}`.

## What gets recorded

* One flow per **task, per tab**: agents working in different tabs of one browser never mix. A task starts when the agent first acts on a site and ends after a consequential step (a submit or send); an agent that then opens another job or page (another `ID=`, `/j/<id>` in the address) starts a new flow. A flow also ends after 30 idle minutes. Moving between sibling hosts of one organisation (`joblink.allibo.com` to `am.allibo.com`), or a redirect within five seconds of a click, stays in the same flow (`hosts` lists them).
* **Named tasks:** bracket a task with `flow_task_begin` / `flow_task_end` and it is one flow whatever the site does in between (hosts, confirmation pages, other jobs). `flow_task_end` records how it went (`success`, `failure`, `incomplete`, `dry_run`); that outcome is final, whatever the automatic page check guesses later.
* A visit that only looked around (pages opened, links clicked, nothing filled, chosen, uploaded, pressed or submitted) is **not saved**, and neither are private windows or the ignored sites (mail, `accounts.google.com`, the LinkedIn feed, Careerjet listings; change the list with `BROWSERFORGE_FLOW_IGNORE=host,host/path`).
* Every click, typed value, chosen option, key press and file upload, with: the page, the element (see below), whether it was consequential, and the iframe it was in. A checkbox or radio click remembers the state it left the control in, so a replay only clicks when the state differs.
* Values you typed become **parameters** named after the field (`first_name`; a generic label such as `autocompile` is skipped in favour of the field's name or id). Pass the task's own values to `flow_task_begin {params}` and a typed value that matches one takes that name and is not stored. **Personal values are not stored:** names, e-mail, phone, birth date, address, links and free text become parameters without a default (you pass them when you replay or export). Harmless short answers ("Yes", "Italian") keep their default. Turn on `BROWSERFORGE_FLOW_VALUES=1` to keep everything, and "Also keep the text I type" does so for what you do yourself in "Record me". Sensitive fields (passwords, card numbers, tokens) never have a value either way.
* Session tokens (`t`, `aid`, `token`, `session`...) are removed from stored addresses, and e-mail addresses and long numbers from labels and locator names.
* Files: `~/.config/browserforge/flows/<site>/<time>.json`, private (0600). The file appears with the first step that changes something. Unnamed flows are deleted after 30 days (3 days for an unfinished one with almost nothing in it, and the oldest beyond 50 per site); flows you saved or that ended in `success` are never deleted automatically.

## Tools

| Tool | |
|---|---|
| `flow_task_begin` / `flow_task_end` | Bracket one task as one flow, with its parameters, a `dryRun` flag and (at the end) the outcome |
| `flow_list` | Flows, newest first, with outcome, task name and replay results; filter by site, outcome, saved; `hints` names tasks that succeeded three times and can be merged |
| `flow_prune` | Report (default) or, with `apply:true`, carry out a tidy-up of old recordings: browsing-only and ignored ones are deleted, personal values and tokens are scrubbed, mixed-job flows are flagged. Saved flows, successes and replayed flows are never deleted |
| `flow_get` | One flow in full |
| `flow_save` | Name a flow and keep it |
| `flow_delete` | |
| `flow_record` | Turn recording on or off |
| `flow_export` | Write a script: `playwright-ts`, `playwright-py`, `selenium-py`, `selenium-java`, `puppeteer-replay`, `json` (plus formats from plugins) |
| `flow_run` | Replay in the connected browser with no model. The page looks for each element for up to 3.5 s and ignores disabled ones (a submit that unlocks after a file is attached). Approvals still apply; it stops at the first step it cannot do, reports how each element was found, and counts the run on the flow (`runs`) |

CLI: `browserforge flow list`, `browserforge flow export <id> --format playwright-ts --out flow.ts [--defaults]`.

## Exported scripts

* They try **several locators per element** in order (test id, role and name, label, placeholder, id, name, text, CSS, XPath) and use the one that matches exactly one element.
* **Parameters** come from `flow-params.json` or `FLOW_PARAM_<NAME>` variables. Recorded values are only embedded with `--defaults` / `includeDefaults:true`, never for sensitive parameters.
* **Consequential steps** (submit, send, upload, password) are guarded: outside BrowserForge there is no approval prompt, so the script stops before them unless `FLOW_CONFIRM=1`. Review the flow first.
* Playwright scripts take `BROWSER_PATH` (use your own Chrome), `HEADLESS=0` (watch it run). Selenium needs a matching chromedriver.
* Chrome Recorder JSON imports into DevTools > Recorder and runs with `@puppeteer/replay`; it cannot hold the guard, so its title says how many consequential steps it contains.

## The neutral format (version 1)

```json
{
  "version": 1,
  "id": "example.com/20261030T101500",
  "site": "example.com",
  "name": "Signup",
  "createdAt": "2026-10-30T10:15:00.000Z",
  "saved": true,
  "params": [{ "name": "first_name", "sensitive": false, "default": "Ada", "label": "First name" }],
  "steps": [
    { "action": "navigate", "url": "https://example.com/signup", "ts": 1 },
    { "action": "fill", "param": "first_name", "locator": { "label": "First name", "id": "first", "css": "#first", "xpath": "//*[@id=\"first\"]" }, "ts": 2 },
    { "action": "click", "consequential": true, "locator": { "role": "button", "name": "Submit", "css": "form > button" }, "ts": 3 }
  ]
}
```

Step `action` is one of `navigate`, `click`, `fill`, `select`, `press`, `upload`. A locator may carry `testId`, `role` + `name`, `label`, `placeholder`, `id`, `nameAttr`, `text`, `css`, `xpath`. A step inside an iframe has `frame: { url }`. A `select` with `custom: true` is a custom dropdown (click the opener, then the option with that text).

## Merging recordings and turning a flow into a skill

Doing the same task on the same site again and again (every application, every signup) piles up recordings. `flow_consolidate` merges them into one kept flow:

* The longest successful recording is the backbone; a step stays only if it appears in at least half of the recordings, so wrong turns and one-off popups drop out. A consequential step (a submit) always stays.
* Two steps are "the same" when they share any way of finding the element (test id, role and name, label, id...), so a recording that found a test id lends it to the others.
* The same step twice in a row collapses (a fill keeps its last value). Parameters carry over; one that was sensitive anywhere stays sensitive and never has a default.
* The result is a named, kept flow with `derivedFrom` listing its sources. `browserforge flow consolidate <site> --name "Sign up"` does the same from the shell.

`flow_to_skill` (or `browserforge flow to-skill <id> --name shop-signup`) writes a skill folder in `<config>/skills/<name>/`: a `SKILL.md` and one workflow that calls `flow_run` with the flow's parameters as inputs. **No recorded value is copied into it** (only parameter names), so it is safe to share. Anyone can then run it with `skill_run_workflow` and their own values; approvals still apply to every consequential step. The skill works at once; its `/mcp__browserforge__<name>` prompt appears after the server restarts.

## How the task ended

A moment after a consequential step (a submit), BrowserForge reads the page's headings and alerts and records whether it shows a confirmation or an error, in English, Italian, French, Spanish and German. That `outcome` (`success` or `failure`) is stored on the flow (a later check replaces an earlier one, since an agent may fix the form and submit again; `browser_verify` sets it too, and only the agent's own `flow_task_end` is final). A flow left without ever submitting becomes `incomplete`, counted in the site's knowledge ([SITES.md](SITES.md)) and used to label the run for fine-tuning. It is a keyword check on short page cues, not a guarantee: a page it cannot read leaves the outcome empty. `browser_verify` gives you the same check on demand.

## Recording yourself ("Record me")

By default flows capture what an agent does. Turn on **Record me** in the extension popup and BrowserForge also records what **you** do in the browser, in a separate flow marked `source: "human"`, so your own work can be replayed by an agent or used to train the local model.

* **Off by default**, with the toolbar badge showing **REC** and a banner in the popup while it is on. Never in private windows. Switching it off stops it at once.
* It records your **clicks, selections and typed fields** in the main page of a tab (and in frames BrowserForge has already entered). Only real input counts: events created by BrowserForge's own tools are never taken for yours.
* **Typed text is not kept** unless you also tick "Also keep the text I type"; otherwise a flow only knows which field a value went into (it becomes a parameter with no default). **Passwords, card numbers, one-time codes and similar fields are never recorded with a value**, whatever the switches say.
* You can say what you are doing ("Apply for a job with my CV"); it becomes the goal of the training examples.
* After you submit, a pause of 20 seconds or more starts a new flow, so two applications in a row are two flows, which `flow_consolidate` can then merge.
* Everything stays on this computer: `<config>/flows/` and `<config>/knowledge/`.

## Writing an exporter

An exporter is `{ format, description, extension, generate(flow, { includeDefaults }) }`. Built-ins live in `packages/flows/src/exporters/`; plugins can add more through `definePlugin({ exporters })` ([PLUGINS.md](PLUGINS.md)). Honour the three rules: never embed a sensitive value, only embed defaults when asked, and refuse to perform consequential steps unattended unless the user opted in.

## Limits

* Locators are computed from the live page, so a redesigned site needs a new recording. `flow_run` and the scripts report the step that no longer matches.
* "Record me" does not see keystrokes inside rich-text editors that have no change event, drag and drop, or hover menus; it records the page you act on, not the sites' own scripts. Use the agent for those.
* Canvas apps, closed shadow roots and elements inside sandboxed iframes cannot be recorded. Elements in **open** shadow roots are recorded with the CSS of their shadow hosts and replayed through them; Playwright exports reach them too, while Selenium and Chrome Recorder exports refuse such a flow (export Playwright instead). When several equal elements match (two "Add" buttons) the locator records which one (`nth`).
* "Record me" sees the person's own events inside open shadow roots, but only in frames the extension is already running in: iframes are not recorded for the person unless an agent has used them. A click on a disabled control is refused (`ELEMENT_DISABLED`) and not recorded. Autocomplete suggestions and custom dropdown options are still recorded as clicks on the option's text, not as parameters.
* Custom dropdowns replay as click-opener-then-click-option, which works for most but not all widget libraries.
