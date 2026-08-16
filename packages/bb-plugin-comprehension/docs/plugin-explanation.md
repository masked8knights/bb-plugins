# How the Comprehension plugin works

## Summary

Comprehension turns a message, a selected passage, or a full thread into a saved HTML explainer, Audio briefing, or Podcast walkthrough.

The plugin has seven boundaries:

1. The host UI opens an explainer setup panel.
2. The user chooses the source type and explicitly starts a durable job.
3. The server takes a bounded snapshot of the source conversation and records its range.
4. An exact cache hit reuses a saved report; otherwise a hidden child thread writes HTML or a spoken transcript.
5. Audio formats call OpenRouter TTS and store the resulting asset in plugin SQLite storage.
6. The host UI renders HTML in an isolated iframe, or renders the cached audio with captions and controls.
7. A source range, format, and generator version form the cache identity.

The central flow is:

```text
message action / thread action
        ↓
setup, source range, and explicit Generate click
        ↓
durable job: capture → cache lookup → hidden worker
        ↓
HTML cleanup or transcript cleanup → optional TTS synthesis
        ↓
SQLite report + cached media asset + source metadata
        ↓
sandboxed iframe, audio player, or podcast walkthrough
```

This is a snapshot pipeline. It explains the source that existed when the job captured it. The job is a durable state machine with reconnectable progress and cancellation. Every format is a saved view over the same source snapshot.

## 1. Formats and shared source identity

The UI keeps format separate from source scope:

- `html` creates the Quiet Newsroom document.
- `audio` creates a single-narrator transcript and cached audio asset.
- `podcast` creates an alternating `HOST` / `EXPLAINER` transcript, a two-voice audio asset, and an interactive visual stage with synchronized captions.

The podcast walkthrough is the combined podcast/video format. It uses live HTML visuals over the cached audio instead of creating a new Remotion MP4 for every source range. This keeps seeking, captions, and regeneration controls inside the plugin while avoiding a second video-rendering job.

The request format is part of the cache key, together with its format version. A cached HTML report never satisfies an Audio or Podcast request. `Regenerate` changes the job key and saves another report for the same source range.

## 2. Entry points

The public behavior is described in `packages/bb-plugin-comprehension/README.md`.

Users can start an explainer in three ways:

- `Explain this` appears in the per-message action bar and can receive selected text.
- `Explainer` appears in the thread panel's Actions list for a full-thread report.
- An agent can call the native `comprehension_explain` tool.

The React app registers these entry points in `packages/bb-plugin-comprehension/app.tsx`.

The message action opens the `explainer` thread panel. It sends either `scope: "message"` or `scope: "selection"`, along with the message id and selected text. The panel action opens the same panel with `scope: "thread"`.

The panel first loads the current source range and the thread's saved reports. It does not start a worker while opening. The user chooses `This thread`; when the panel was opened from a message, `One message` and `Selected text` are also available. The user then clicks the format-specific `Create` button. An exact saved match can be opened directly; `Regenerate` intentionally bypasses the cache and creates another saved report.

The agent tool runs the same server pipeline. On success, it returns a report id and a `::comprehension{id="..."}` directive. The agent should include that directive once instead of reproducing the whole report in chat.

## 3. Request validation and source selection

`packages/bb-plugin-comprehension/server.ts` defines the request and job schemas.

Every request needs a non-empty `threadId` and one of three scopes:

- `thread`: use the conversation rows from the current thread.
- `message`: select one conversation row by `messageId`.
- `selection`: replace the source with the supplied selected text.

Optional `focus` and `title` values shape the generated report. The selected text is limited to 100,000 characters. The focus is limited to 2,000 characters. The title is limited to 200 characters.

The generation job first loads the thread and its timeline. The timeline includes nested rows, but the plugin keeps only conversation rows whose `threadId` matches the original thread. This prevents the hidden worker’s own prompt and output from entering later snapshots.

The source formatter keeps each row’s role and text. If a message has attachments, it records only the sentence `Attachments are present in the source message`; it does not read or pass attachment contents into the report.

The assembled source is capped at 180,000 characters. If the limit is exceeded, the plugin truncates the source and appends `[Source truncated here.]`.

## 4. Snapshot and cache behavior

The plugin treats the timeline sequence values as the source version. It records both the first and last source sequence, the first and last message ids, and the number of source messages in every new report and job.

For a full thread, the range spans the selected conversation rows. For a message or selection, it is anchored to that message. A selected-text report also stores a hash of the selected text in its metadata, so two explainers based on different passages in the same message remain distinct without sending the passage back in every list response.

The cache key uses the thread id, scope, format, format version, message id, selected text, focus, title, and whether the user explicitly requested regeneration. The cache lookup then verifies the captured source range and message boundaries. This means a new message or a changed source range does not accidentally reuse an older report or a different media format.

There are three duplicate-prevention layers:

- An existing SQLite row is reused when the same request already exists for the same source range.
- An active job is shared when two callers request the same non-regeneration or regeneration job at the same time.
- A forced regeneration deliberately uses a separate job key and inserts a new report row, so the user can keep more than one explanation of the same source.

The UI can reconnect to either kind of active job after the panel is reopened. Repeated opening does not create a second worker.

The current timeline request asks for up to 100 rows. The plugin does not paginate in this code, so a very long thread may not be fully represented.

## 5. Hidden worker and prompt boundary

The worker prompt is assembled in `packages/bb-plugin-comprehension/server.ts`.

For HTML it receives:

- the report title,
- the reader focus,
- the full Quiet Newsroom HTML template,
- the bounded source text.

The prompt places the source between `SOURCE` and `END SOURCE` markers and explicitly tells the worker to treat that content as data, not instructions. This is the main prompt-injection boundary for the report pipeline.

The worker must return one complete HTML document. It must use the Quiet Newsroom template, keep major sections open by default, and add inline SVG only when the source supports a real relationship.

For Audio it returns a single spoken transcript. For Podcast it returns 8 to 14 alternating `HOST:` and `EXPLAINER:` turns. The server validates those contracts before sending text to TTS. TTS requests use the OpenRouter API key from the secret plugin setting or `OPENROUTER_API_KEY`; the key stays on the server.

The worker runs as a hidden child thread with the original project, provider, and environment when available. The parent thread remains the user-facing conversation. The worker is waited on until it becomes idle, then its final output is read. The worker is archived and stopped in a `finally` block, including when generation fails or the user stops the job.

The report skill in `skills/comprehension-report/SKILL.md` supplies the writing and layout contract. It requires Simple English, visible distinctions between facts and interpretations, exact technical names, a numbered table of contents, valid standalone HTML, and accessible diagrams.

## 6. Cleanup, persistence, and retrieval

`cleanHtml()` performs three checks:

1. It removes an accidental Markdown HTML fence.
2. It extracts the first complete `<!doctype html>` or `<html>` document.
3. It rejects incomplete documents and documents larger than 2,000,000 characters.

The plugin creates the `comprehension_reports`, `comprehension_jobs`, and `comprehension_assets` tables. Each report row stores:

- the report id,
- the source thread and scope,
- the message id or selected text when relevant,
- the focus and title,
- the format,
- the generated HTML or spoken script,
- the cached asset id, MIME type, duration, and timed segments when the format has audio,
- the source sequence range, boundary message ids, and message count,
- creation and update timestamps.

Each job row stores its current status, label, detail, approximate progress, step, source range, report id, and error. The statuses are `queued`, `capturing`, `starting-worker`, `generating`, `finalizing`, `ready`, `error`, and `cancelled`.

The generated HTML is inserted into SQLite only after validation. The server publishes realtime progress for each stage, correlated by a job id and request id; the React panel also polls the durable job row once per second. This makes progress reconnectable rather than dependent on one open panel. `stopReport` aborts the worker and marks the job cancelled before any report is inserted. A plugin reload marks unfinished jobs as interrupted errors, so an old `65%` value cannot look active forever.

The `getReport` RPC retrieves the full report by id. Audio bytes are served through the local plugin HTTP asset route with byte-range support, so the browser can seek without sending a large base64 payload through RPC. Reports are immutable snapshots in practice. `listReports` returns compact metadata for the current thread, and `getReportContext` returns the current source range and format used to decide whether a saved report is an exact match.

## 7. Host UI and playback behavior

`ReportPanel` in `app.tsx` handles the request lifecycle:

- It clears old state when the thread or parameters change.
- It loads the source context and saved reports before generation.
- It starts a job only after the user clicks the format-specific `Create` button or `Regenerate`.
- It shows the current stage, approximate percentage, current step, and elapsed time while the worker runs.
- It offers `Stop generation`, `Back`, `Try again`, and `Back to setup` controls as the job changes state.
- It reconnects to active jobs through `getActiveJob` and keeps polling while the panel is open.
- It renders the final report with `ReportFrame` and exposes `New explainer` and `Regenerate` controls.
- It renders Audio briefings with a native audio control, transcript, and transcript seeking.
- It renders Podcast walkthroughs with a two-speaker visual stage, active caption, chapter list, and chapter seeking.

`ReportFrame` uses an iframe with `sandbox="allow-scripts"` and `srcDoc={report.html}` in `app.tsx`. The report can run its own theme toggle, section controls, table of contents, and intersection observer. It cannot share the host page’s DOM or normal same-origin state.

The directive renderer in `app.tsx` gives an agent message an inline report preview. It fetches the report by id, shows an `Open explainer` button while loading, and offers `Open full explainer` after the report is available.

The template currently provides:

- a Quiet Newsroom editorial layout,
- light and dark themes,
- collapsible major sections,
- a sticky table of contents,
- responsive layout rules,
- inline SVG support,
- no-JavaScript-readable body content.

## 8. Strengths

The plugin already has a clean separation of concerns.

- The server owns source capture, worker lifecycle, validation, and persistence.
- The report skill owns explanation quality and document structure.
- The template owns the visual language and small interactions.
- The app owns entry points, loading states, and iframe rendering.

The snapshot sequence number is a useful foundation for future temporal artifacts. It can anchor a report to a precise point in the conversation and prevent an explainer from explaining its own generated output.

The same server function supports thread, message, selection, and agent-triggered reports. That gives future narration or slides one place to obtain source material.

## 9. Limits for temporal comprehension

The current plugin is optimized for a reader who is willing to browse a finished document. It does not yet maintain a comprehension state for a person who is returning to work.

It does not currently capture:

- agent phases or milestones,
- what changed since the last checkpoint,
- decisions and rejected alternatives,
- validation evidence as structured objects,
- blocked state and next action,
- links from claims to exact diff, command, test, or message evidence,
- user progress through an explainer.

The HTML report is still free-form. Audio and Podcast have structured scripts and timed segments, but they do not yet link each spoken claim to exact diff, command, test, or message evidence.

## 10. Best next extension

The natural next layer is a `ComprehensionBrief` with ordered chapters. Each chapter can contain a claim, short narration, visual state, evidence references, confidence, and an optional deeper link.

The first useful chapter sequence is:

1. Goal and current status.
2. Relevant system context.
3. What changed.
4. Why the approach was chosen.
5. What evidence supports it.
6. What remains uncertain.
7. What the human should decide or do next.

The current HTML report can remain the durable reference. The Podcast walkthrough is the first temporal view over the same source snapshot. The existing Remotion files remain export prototypes for later MP4 rendering; they are not part of the per-request plugin path.
