# Agent Checklists

Agent Checklists gives a BB thread a persisted, structured set of steps. The
agent can read and update the checklist through native tools, while the
workbench shows progress, notes, evidence, and continuation state.

## Included templates

- **Software delivery** — carries a coding task from understanding through
  validation and handoff.
- **Research to technical document** — turns source-supported research into a
  clear technical document with a simplified technical-English pass.

## Create your own checklists

Open Agent Checklists in the workbench to see the row-based collection. Create
a todo list or workflow, open any row, and edit its name, description,
continuation default, and ordered steps. Built-in examples are protected, but
you can copy them into an editable checklist.

Saved custom checklists appear in every thread’s attachment picker. A thread
keeps a snapshot of the steps it used, so later template edits do not change
work that is already in progress.

## Continuation modes

- **Automatic** — when the agent becomes idle with unchecked steps, BB sends an
  agent-only reminder and resumes the thread.
- **Approval** — BB waits for the user to approve each continuation.
- **Tracking only** — BB records progress without waking the agent.

Every checklist has a configurable continuation limit. Pausing a checklist,
checking a step, adding notes, or adding evidence never requires proof. The
checkbox is the source of truth.

## Agent tools

- `agent_checklist_get` reads the checklist attached to the current thread.
- `agent_checklist_update` checks or unchecks a step, adds a note or evidence,
  or pauses the checklist.

Install from this repository with:

```sh
bb plugin install ./packages/bb-plugin-agent-checklists --yes
```
