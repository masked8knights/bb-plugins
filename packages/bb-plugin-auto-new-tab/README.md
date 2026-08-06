# bb-plugin-auto-new-tab

Open the **New Tab** page automatically whenever the workspace side panel is
open with **no tabs**, instead of bb's default **Info** page (thread
metadata).

## Install

```bash
bb plugin install ./packages/bb-plugin-auto-new-tab
```

Then reload the bb window (⌘R) so the frontend content script mounts. No
configuration needed; disable it any time from Extensions → Plugins.

## What it does

When the workspace panel opens with no active tab, bb's panel state falls
back to a fixed `thread-info` tab — the Info page. There is no setting for
this and the plugin SDK has no workspace-tab API, so the plugin ships a
frontend content script that drives the app's own tab strip:

1. Confirms the workbench is already open. The collapsed panel remains mounted
   in the DOM, so this check prevents the plugin from opening it as a side
   effect.
2. Watches the DOM for the Info tab pill becoming the active tab
   (`[data-testid="thread-info-tab"] button[aria-pressed="true"]`) — i.e.
   the Info page is on screen and no file tab is active.
3. Confirms no real tab is open (file/browser/terminal/plugin tabs always
   render a close button; fixed tabs don't).
4. Clicks the panel's "Open new tab" button — the same action as pressing
   `+` in the tab strip — with a short debounce and re-validation so a fast
   user action always wins.

The panel state persists per thread, so this only fires when there genuinely
are no tabs: a fresh open, or after the last tab is closed. It never touches
the panel once a real tab is open, and the root-compose screen already
auto-opens a New Tab, so this only changes thread/workspace views.

## Notes

- Frontend-only: `server.ts` exists because bb plugins require a server
  entry.
- Uses stable DOM hooks (testid, aria labels) rather than app internals, so
  it degrades to a no-op if bb changes its chrome.

## License

MIT
