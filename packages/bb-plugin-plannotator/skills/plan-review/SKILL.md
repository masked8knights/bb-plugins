---
name: plan-review
description: Use the upstream Plannotator review gate before implementing a concrete plan in BB.
---

# Plannotator plan review

Before changing files or taking implementation actions, call
`plannotator_review_plan` with the complete Markdown plan.

The tool opens the upstream Plannotator app in BB's right panel and waits for
the user's decision:

- `decision=approved`: continue with the approved plan.
- `decision=changes_requested`: revise the plan using the returned feedback,
  then call the tool again.
- `decision=cancelled`: stop and ask what should change.

Do not claim approval from the presence of a review panel alone. Only the
returned tool decision is authoritative.
