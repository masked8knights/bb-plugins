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

The call blocks for one or more minutes. Tell the user the council is
deliberating before you call. Do not call it repeatedly for the same proposal;
if the verdict is unclear, summarize it and ask the user how to proceed.

## Reading results

The result contains the final report: `## Verdict`, `## Reasoning highlights`,
and `## Dissent and minority views`. Report the verdict faithfully; surface
dissent instead of hiding it.

Users can inspect full transcripts in the Council panel. From a terminal,
`bb council sessions` lists sessions and `bb council session <id>` prints one
transcript.
