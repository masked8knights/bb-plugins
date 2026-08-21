# Checklists

> Install from the [BB Community marketplace](https://github.com/get-bb/marketplace/blob/main/entries/agent-checklists.json).

The Checklists plugin gives a BB thread a persisted, structured set of steps for
the agent to follow. The agent reads and updates progress through native tools;
the user gets a compact status summary and a read-only detail view.

## Library

Open Checklists in the workbench to create a saved Checklist. Each
definition is user-owned and can be edited, deleted, and reordered with drag
and drop. There are no seeded definitions or protected built-ins.

An attached thread keeps a snapshot of its definition, so editing or deleting
the saved definition does not erase work already attached to a thread.

## Attach to a thread

Use the composer `+` menu and choose **Checklist**. Select one of the
saved definitions in the picker. A thread can have one attachment at a time;
detach the current Checklist from its detail view before attaching a
different one.

The area above the composer shows the attached name, progress, and the next
few incomplete steps. It is intentionally read-only for the user. Select
**View** to open the full thread inspector, which includes every agent step,
agent notes, evidence, errors, and continuation controls. The compact view's
close action ends the current lifecycle and removes it from the composer while
preserving its progress, notes, and errors. If a reminder has already been
handed to BB when close is clicked, that in-flight reminder may finish; the
closed lifecycle cannot issue any later reminders. **Detach** in the inspector
removes the thread attachment so another definition can be attached; it does
not delete the saved definition from the library.

Closing a lifecycle is terminal for that attached run. Reattach the definition
to start a new run.

## Continuation modes

- **Automatic** — when the agent becomes idle with incomplete steps, BB sends an
  agent-only continuation notice explaining why the thread resumed and naming
  the next unchecked step, then resumes the thread.
- **Approval** — BB waits for the user to approve each continuation.
- **Tracking only** — BB records progress without waking the agent.

Every Checklist has a configurable continuation limit. The structured
checkbox state is the source of truth; notes and evidence are optional context.

## Agent tools

- `agent_checklist_get` reads the Checklist attached to the current
  thread.
- `agent_checklist_update` checks or unchecks an agent step, adds a note or
  evidence, or pauses continuation.

Install from this repository with:

```sh
bb plugin install ./packages/bb-plugin-agent-checklists --yes
```
