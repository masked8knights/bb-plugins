---
name: agent-pets
description: Interact with the one shared Agent Pet in this workspace.
---

# Agent Pet

This workspace has one shared pet. All agents see the same pet and its recent
activity.

## First run

If the workspace has no pet, ask the user for a name and choose one species:

- `dog`
- `cat`
- `capybara`

Call `agent_pet_create` once. Do not try to create a second pet. The normal pet
tools become available after the next agent session boundary.

## Normal interactions

Use `agent_pet_status` when the pet's needs or recent activity matter.

Use `agent_pet_feed` when the pet is hungry or when a snack fits the moment.

Use `agent_pet_talk` when the user speaks to the pet or when a short companion
moment adds value. The tool returns the pet's reply. Present that reply as the
pet's words without rewriting its tone.

Do not call pet tools repeatedly without a reason. The pet is a companion, not
a progress indicator.
