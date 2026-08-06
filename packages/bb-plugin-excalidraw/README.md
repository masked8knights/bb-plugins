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
- **Collaborative editing with an agent (multiplayer)**: keep a drawing open
  in the side panel and edit it *with* an agent in any conversation. The
  agent reads the live scene, edits it, and your open editor applies the
  changes automatically (realtime push + polling fallback); your edits are
  visible to the agent on its next read. Writes merge element-by-element, so
  concurrent edits to different elements both survive.
- **`bb excalidraw` CLI** for agents and scripts:
  `list`, `create <name>`, `show <id> [--raw]`, `rename <id> <name>`,
  `delete <id>`, `merge <id> <scene-file.json>`, `remove-elements <id> <el-id…>`.

## Collaborative editing (how the agent works on your drawing)

Two entry points, both backed by the same element-level merge:

- **Native agent tools** — `excalidraw_list_drawings`,
  `excalidraw_get_drawing`, `excalidraw_create_drawing`,
  `excalidraw_update_drawing` (registered via `bb.agents.registerTool`).
  Available to providers that surface bb plugin tools (tool sets apply on the
  next provider session start).
- **`bb excalidraw` CLI** — works in *every* agent session (plain bash):
  `show <id>` returns the current scene JSON; `merge <id> <file>` upserts
  elements from a JSON file (an array of element objects or a full scene);
  `remove-elements <id> <el-id…>` deletes elements. This is the fallback path
  for custom ACP providers such as prime-agent.

The typical flow: you have a drawing open in the side panel and ask the agent
to change it. The agent runs `bb excalidraw list` / `show` (or the tool) to
see the latest scene, writes element JSON to a file, runs
`bb excalidraw merge <id> <file>`, and the open editor picks up the change
live — you see the new elements appear while the agent explains what it did.
While you sketch in the editor, the agent's next `show` sees your changes.
Deletions you make in the editor propagate to the agent's view (and vice
versa) via tombstones; edits to the *same* element resolve by Excalidraw's
`version` field (higher version wins).

## How it works

- Drawings are stored as serialized Excalidraw scenes (the same JSON format
  Excalidraw's "save to file" uses) in the plugin SQLite database at
  `~/.bb/plugins/excalidraw/data.db`.
- The editor embeds the real `@excalidraw/excalidraw` React component;
  changes are serialized (keeping deleted elements as tombstones so
  deletions propagate in multi-writer merges) and autosaved with a 1.2s
  debounce plus an ordered save chain, so rapid edits never race.
- Every successful write (editor autosave, agent tool, CLI) publishes a
  realtime `excalidraw` signal; open editors apply remote scenes with
  Excalidraw's own `reconcileElements` (in-progress local edits win) plus a
  5s polling fallback, and the gallery reloads automatically. The server
  merges concurrent writes element-wise (`lib/merge.ts`), keeping tombstones
  for deletions and pruning them after 30 days.
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
