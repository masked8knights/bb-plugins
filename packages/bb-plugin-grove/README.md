# bb-plugin-grove

Grove adds a document-agent workflow to BB Docs. A Markdown document can have
one visible owner thread. Dictation is transcribed by BB's existing voice
service, queued to that thread, and shaped into Markdown by the agent. Direct
editing remains available and all agent writes use SHA-256 compare-and-swap.

## Install

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-grove --yes
bb plugin reload grove
```

Open a Markdown file in Docs, choose **Open with → Grove writing**, then start
the document agent. The Grove sidebar also accepts an absolute Markdown path.
The document agent thread is the audit trail for queued dictation and agent
edits.

## Agent and CLI surfaces

Owner threads receive the `grove_read_document` and `grove_apply_document`
tools. Agents and humans can queue a text passage with:

```sh
bb grove list --json
bb grove status <binding-id> --json
bb grove restart <binding-id> --json
bb grove dictate <binding-id> "Turn this passage into a concise opening."
```

The plugin stores binding metadata and queue state in its own SQLite database.
It does not copy document bodies outside the Docs file or the BB thread audit
trail.
