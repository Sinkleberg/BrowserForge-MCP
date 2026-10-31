# The agent window

By default an agent works in whichever tab is active, which is the tab you are using. With **Agent window** on, it works in a window of its own, and you can take over at any time.

## Turning it on

Extension popup > **Agent window** > tick *The agent works in its own window*. It is off by default and stays as you set it.

## What changes

* The first time the agent navigates (`browser_navigate` with no tab chosen), BrowserForge opens a new window **without taking focus** and loads the page there. The agent keeps working in that window.
* `browser_navigate` with `newTab: true` opens the tab **inside the agent window**. A page the agent opened that opens more tabs (an "Apply" link with `target=_blank`) adds them to the agent's tabs, so it can close them without asking.
* Reads and actions with no tab chosen go to the agent window's active tab, never to the tab you are looking at. If the agent window is not open, the agent gets an error that says to open a page with `browser_navigate` or choose one of your tabs with `browser_select_tab`.
* **Working in one of your tabs on purpose** is still possible: `browser_select_tab` (or a `tabId`) targets any tab, and closing one of your own tabs still asks you first. `browser_get_tabs` marks the agent's tabs with `agent: true` and `inAgentWindow: true`.
* Closing the agent window yourself is fine: the next navigation opens a new one.

## Taking over

* **✋ Take over** (popup) is STOP plus bringing the agent window to the front: everything in flight is cancelled and the agent is refused (`STOPPED`) until you hand control back. Do what you need by hand in that window.
* **Hand back to the agent** (the button in the "Stopped by you" notice) lets it carry on. The agent cannot resume itself.
* **Close agent window** closes it from the popup.

## What it is not

The agent window shares your browser profile and its logins: **it is not a separate account or a security sandbox**. The approval gate, YOLO and STOP work exactly as before. It is also not hidden: it is a normal window you can see and move.

## Why

An agent that shares your active tab fights you for it: you click away and its next action lands on the wrong page, a popup steals focus, and you cannot tell which page is yours. Its own window removes that whole class of problem.
