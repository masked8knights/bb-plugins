# Comprehension

Comprehension turns a message, a text selection, or a full thread into a clear HTML explainer.

It provides:

- `Explain this` on messages and selected text.
- `Explain this thread` in the thread header.
- A native `comprehension_explain` tool for agents.
- A hidden worker that writes a standalone Quiet Newsroom HTML document.
- A `::comprehension{id="..."}` directive for opening an explainer from an agent message.

The report worker follows the `comprehension-report` skill in `skills/`. Generated HTML is shown in a sandboxed iframe so the report can include its own theme toggle, collapsible headings, tables, and inline SVG diagrams without sharing the host page's DOM.
