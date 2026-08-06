# bb-plugin-excalidraw

Create and edit [Excalidraw](https://excalidraw.com) drawings inside bb, then
attach them to conversations.

## What you get

- **Drawings panel** (sidebar → Excalidraw): a pure image-first card gallery —
  no titles anywhere, each drawing is its live SVG thumbnail (lazy-rendered
  and cached). Click **+ New drawing** to start immediately. The editor
  autosaves as you work; its toolbar is icon-only: attach to the
  conversation, copy the image to the clipboard, download the PNG, or
  delete.
- **Attach as an image via the composer `+` menu**: in any conversation,
  open the `+` menu → **Excalidraw drawing**, pick a drawing, and the
  rendered PNG is attached to that conversation as an image message.
- **Attach from the thread panel**: open the thread right panel → Actions →
  **Excalidraw**, then **Attach image** on a drawing — same result.
- **`@drawing` mentions** (composer-native): type `@` and pick a drawing to
  add a mention pill; when you send, the agent receives the drawing's scene
  data as context so it can reason about the diagram.
- **`bb excalidraw` CLI** for agents and scripts:
  `list`, `create <name>`, `show <id>`, `rename <id> <name>`, `delete <id>`.

## How it works

- Drawings are stored as serialized Excalidraw scenes (the same JSON format
  Excalidraw's "save to file" uses) in the plugin SQLite database at
  `~/.bb/plugins/excalidraw/data.db`.
- The editor embeds the real `@excalidraw/excalidraw` React component;
  changes are serialized (`serializeAsJSON`) and autosaved with a 1.2s
  debounce plus an ordered save chain, so rapid edits never race.
- Attaching renders the scene to a PNG in the browser
  (`exportToBlob` — no editor mount needed), base64-encodes it, and the
  server uploads the bytes with
  `bb.sdk.projects.attachments.upload` then sends them to the thread with
  `bb.sdk.threads.send` as a `localImage` prompt input. The `+` menu flow
  uses a host-rendered picker (`bb.ui.requestInput` +
  `pendingInteraction` slot).
- Mention pills are backed by a server-side mention provider (`@drawing`)
  whose `resolve` attaches the current drawing scene to the message at send
  time.

## Development

```
bb plugin install .     # register (path install; server.ts loads from source)
bb plugin dev           # watch: rebuild frontend + reload on every save
bb plugin build .       # emit dist/ (server.js + app.js/app.css)
npx tsc --noEmit        # typecheck (types are vendored in types/)
```

Notes:

- `@excalidraw/excalidraw`'s CSS is vendored at `assets/excalidraw/`
  (the package's `exports` map doesn't expose the CSS subpath to the plugin
  bundler; the Assistant webfonts are inlined as data URLs because the
  bundler has no `.woff2` loader).
- The frontend bundle is large (~13 MB) because it embeds the full Excalidraw
  editor; it only loads when the plugin surfaces are mounted.
- `sonner` types are shimmed in `types/sonner.d.ts`; the host provides the
  runtime.
