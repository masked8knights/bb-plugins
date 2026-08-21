# Council

Council convenes a panel of advisor agents that independently review a proposal, discuss it among themselves, and return a verdict with dissent. One proposal in, one structured deliberation out.

It provides:

- A **Council** panel for managing members and reading session transcripts.
- A native `council_deliberate` tool that blocks while the council deliberates and returns the verdict report.
- A `bb council` CLI (`sessions`, `session`, `convene`) for inspecting and convening from any thread or terminal.
- Three seeded default members on first run; every member is fully editable.

## How a session runs

1. **Consideration** — every enabled member gets its own hidden worker thread and reviews the proposal independently, ending with a `STANCE:` line (`support`, `oppose`, or `abstain`).
2. **Discussion** — up to N rounds (setting, default 2). Each member sees the others' current positions and can comment, pass, or change stance. The loop stops early when consensus is reached.
3. **Verdict** — the chief justice writes the final report: verdict, reasoning highlights attributed to members, and dissent/minority views. If the chief was recused mid-session, the first remaining member writes it; if no member remains, a fallback report lists recorded positions.

The tally counts each member's latest explicit stance. A transport failure or timeout never flips a member's prior vote — it only makes them silent for that round. Members whose spawn fails are marked `recused` in the roster and excluded from consensus math.

Consensus rules: `majority` (default) needs more than half of active members supporting, with support exceeding opposition; `unanimous` needs every active member supporting.

## Members

Members live in the plugin database and are managed in the panel. Each has:

- **Name** shown in transcripts and prompts.
- **Persona** injected as judgment instructions ("You are…"). Write principles and evaluation criteria, not role-play fluff.
- **Provider / model / reasoning level** — leave empty to use the project default. Explicitly chosen values are marked caller-explicit so bb does not silently re-derive them from project defaults.
- **Chief justice** flag — exactly one chief writes the verdict.
- **Enabled** toggle — disabled members are skipped at convene time.

Default members: **Grug** (chief; grugbrain.dev pragmatism — complexity is the enemy, 80/20 solutions, Chesterton's fence), **Architect** (systems thinking, boundaries, trade-offs), **Designer** (user experience, states nobody designed, accessibility). They are seeded once; deleting them is permanent.

## Using it

From an agent thread, call the tool:

```
council_deliberate({ proposal: "...", context: "optional diffs/constraints" })
```

`context` is passed to every member as supplementary material. The call blocks for one or more minutes; do not retry it while waiting.

From the panel, use **Start a council conversation**. It does not deliberate inline — it seeds a new thread whose first message instructs the agent to present your proposal to the council via `council_deliberate` and report back the verdict. You watch the work happen, can steer it mid-flight, and keep a conversation going afterward ("what would change if we…?").

From a terminal or thread shell:

```
bb council sessions
bb council session <id>
bb council delete <id>
bb council convene "<proposal>"
```

`bb council convene` blocks and prints its session id with the report. Cancel it and the session is recorded as cancelled; member threads are stopped either way.

Deleting a session removes its transcript, turns, and roster permanently — from the panel (Delete button on each session card) or via `bb council delete`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Discussion rounds (max) | 2 | Upper bound on discussion rounds |
| Per-response timeout (seconds) | 240 | Wait per member response before recusing them |
| Consensus rule | majority | `majority` or `unanimous` early-stop rule |
| Max council members | 7 | Guard rail on panel-created members |

## Behavior notes

- Member threads are hidden, stopped, and archived on every exit path, including failures, cancellation, and plugin dispose.
- Failed/cancelled sessions keep their transcript and an error message; nothing stays stuck in `running`.
- Sessions, turns, rosters, and tallies persist in the plugin SQLite store and survive reloads.
