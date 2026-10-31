# Site knowledge cards

BrowserForge remembers what it learns about each site, so the next agent does not rediscover it. When an agent opens or selects a tab on a site that has something worth knowing, the result carries a short **`siteCard`**:

```
jobs.example.com, seen 6x: past results: 3 ok, 1 failed; needs account: create one with Google sign-in; custom dropdown: Country (x2); 2 recorded flows (flow_list site=jobs.example.com)
```

A card is only added when there is something to say, so ordinary navigation results stay unchanged. It is at most 600 characters.

## Where it comes from

* **Automatically:** visits (agents and, with Record me, you), custom dropdowns and iframe forms that tools had to work around, flows that were named, merged or ended well, and how tasks ended (a confirmation or an error after a submit, and the verdict of `browser_run_goal`).
* **From agents:** `site_note { site, kind, detail }` for things only they see: `needs_account`, `captcha`, `login_wall`, `file_in_popup`, `listing_gone`, `blocked_by_site`, `custom_dropdown`, `iframe_form` or a free `note`. Keep `detail` to a short plain sentence. Personal data such as emails and phone numbers is scrubbed out of it, and it is capped at 200 characters.
* `site_info { site }` gives the full record, `site_list` lists the sites.

## Where it lives

`<config>/knowledge/sites/<host>.json`, one small private file per site. It holds counts, short notes and flow ids, never page text, typed values or addresses beyond the host. Delete a file to forget a site; `--no-traces` switches the whole memory (and this) off.

## Limits

* It is advice from past runs and can be out of date: a site that needed an account last month may not now. Agents should treat it as a hint, not a rule.
* A card does not make an agent skip a site by itself; what to do about `needs_account` or `captcha` is the user's policy (see the job-apply skill).
* Notes written by agents are not verified.
