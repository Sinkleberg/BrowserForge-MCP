# browserforge-plugin-rendercv

Tailor a [RenderCV](https://rendercv.com) resume to each job posting, render it to PDF, and keep a log of where you applied: for agents driving [BrowserForge MCP](../../README.md).

## What it does

| Tool | |
|---|---|
| `cv_list` | Your master CVs, the tailored copies, and PDFs ready to upload |
| `cv_get` | A CV as sections with a stable id for every piece of text |
| `cv_tailor` | A tailored **copy**: new headline and summary, reworded text, reordered or dropped items |
| `cv_render` | PDF via `rendercv` into BrowserForge's upload folder; rejects CVs over your page limit |
| `cv_applications` | `check` before applying (duplicates, daily limit), `add` after, `list`, `update` |

### It cannot invent anything

`cv_tailor` can only change what already exists: ids must exist, and every number, date, link, e-mail, tool name and acronym in the new text must already appear in the master CV (the company and role you are applying to are allowed, because they are the target, not a claim). If the agent writes "7 years" or "Kubernetes" and your CV says neither, nothing is written and the offending words are returned. The fix is to rephrase, or to add the fact to your master CV yourself.

The master file is never modified. Copies go to `tailored/<company>-<role>.yaml` inside your CV folder.

## Install

```bash
browserforge plugin add ./plugins/rendercv          # shows what it asks for, then asks you
browserforge plugin config rendercv cvDir=/path/to/your/cv/folder rendercv=/path/to/rendercv
# restart `browserforge serve`
```

Install RenderCV itself separately (`pip install "rendercv[full]"` in a virtual environment) and point `rendercv=` at its executable.

## Permissions it asks for (and why)

* Read your CV folder: to read master CVs.
* Create and change files in **only** `<your CV folder>/tailored`: tailored copies and render output. Your masters are not writable.
* Create files in `uploads/cv` and read it back: the PDF you will upload, and the list of what is ready.
* Read and write its own `data` folder: the application log.
* Run the `rendercv` program you configured, and nothing else.

It does **not** ask for browser access: it never touches your browser.

## Settings

| | |
|---|---|
| `cvDir` (required) | Folder with your master RenderCV YAML files (searched two levels deep) |
| `rendercv` (required) | Path to the `rendercv` program |
| `maxPages` | Reject a rendered CV longer than this (default 2) |
| `dailyLimit` | Most submitted applications per day `cv_applications` allows (default 10) |

## Use with the `job-apply` skill

[`skills/job-apply`](../../skills/job-apply) strings these tools together with the browser tools: read the posting, check, tailor, render, fill the form and upload, stop for your approval, log. Add it with `browserforge skill add ./skills/job-apply`; it appears as `/mcp__browserforge__job-apply` in Claude Code.

## Develop

`lib/cvdoc.js` has the pure logic (ids, edits, the facts check); `index.js` the tools. Tests: `tests/unit/rendercv-plugin.test.ts` (with a fake `rendercv`) and `tests/integration/plugins.test.ts` (installed for real).
