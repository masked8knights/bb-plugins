---
name: council
description: Use when the user asks to convene, consult, poll, or present work to "the council", or when a plan, design, proposal, or decision would benefit from independent multi-model review before proceeding. Covers the council_deliberate tool and the bb council CLI.
---

# Council

The Council is a standing panel of advisor agents configured by the user. Each
member has its own persona, provider, and model. A deliberation runs in
phases: independent review, discussion rounds (members comment or pass), then a
chief justice writes the verdict with dissent.

## When to convene

Convene the council when the user asks for it ("ask the council",
"present this to the council", "poll the council") or when independent second
opinions clearly help: risky refactors, contested designs, release decisions.

Do not convene for trivial questions, simple factual lookups, or work already
reviewed by the council on the same proposal.

## How to convene

Call `council_deliberate` with:

- `proposal` — the complete proposal, plan, or question under review.
- `context` — optional supporting material: constraints, diffs, background.
- `preset` — optional name of a saved council preset (`bb council presets`) to
  convene a specific panel instead of all enabled members.

The call blocks for one or more minutes. Members research the workspace,
debate with no preset round count, and each registers a final vote through
the `council_register_vote` tool; the session ends when every member has
voted (or at the safety cap). Tell the user the council is deliberating
before you call. Do not call it repeatedly for the same proposal; if the
verdict is unclear, summarize it and ask the user how to proceed.

## Reading results

The result contains the final report: `## Verdict`, `## Reasoning highlights`,
and `## Dissent and minority views`. Report the verdict faithfully; surface
dissent instead of hiding it.

Users can inspect full transcripts in the Council panel. From a terminal,
`bb council sessions` lists sessions, `bb council session <id>` prints one
transcript, and `bb council delete <id>` removes one.

## Managing members

You can manage council members yourself through the CLI:

- `bb council members` — list members with ids and execution settings.
- `bb council member-add <name> --persona "<judgment instructions>" [--provider <id>] [--model <model>] [--reasoning <level>] [--chief] [--disabled]`
- `bb council member-set <id> ...` — same flags; pass `none` to clear provider/model/reasoning.
- `bb council member-delete <id>` — deleting the chief promotes the earliest remaining enabled member.

Write personas as judgment instructions (principles, evaluation criteria,
output expectations), not role-play fluff. Leave provider/model unset unless
the user asks for a specific model.
