import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { migrations, PetStore } from "./src/pet-store";
import { petActions, petSpecies } from "./src/pet-types";

const REALTIME_CHANNEL = "agent-pets";

const speciesSchema = z.enum(petSpecies);
const actionSchema = z.enum(petActions);
const actorSchema = z.enum(["agent", "user", "system"] as const);
const moodSchema = z.enum(["hungry", "sleepy", "lonely", "playful", "content"] as const);

const petSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    species: speciesSchema,
    hunger: z.number().int().min(0).max(100),
    energy: z.number().int().min(0).max(100),
    happiness: z.number().int().min(0).max(100),
    mood: moodSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastDecayAt: z.number().int().nonnegative(),
  })
  .strict();

const eventSchema = z
  .object({
    id: z.string(),
    petId: z.string(),
    action: z.enum(["create", ...petActions] as ["create", "feed", "talk"]),
    actor: actorSchema,
    threadId: z.string().nullable(),
    message: z.string().nullable(),
    reply: z.string(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const stateSchema = z
  .object({
    pet: petSchema.nullable(),
    events: z.array(eventSchema).max(30),
  })
  .strict();

const userInteractInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("feed") }).strict(),
  z.object({ action: z.literal("talk"), message: z.string().trim().min(1).max(500) }).strict(),
]);

const interactionResponseSchema = z
  .object({
    state: stateSchema,
    event: eventSchema,
  })
  .strict();

export const rpcContract = defineRpcContract({
  getState: {
    input: z.null(),
    output: stateSchema,
  },
  userInteract: {
    input: userInteractInput,
    output: interactionResponseSchema,
  },
});

function stateForRpc(store: PetStore) {
  const state = store.getState();
  return state ?? { pet: null, events: [] };
}
function publish(bb: BbPluginApi): void {
  bb.realtime.publish(REALTIME_CHANNEL, { type: "pet-updated", updatedAt: Date.now() });
}

function waitForAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toolState(store: PetStore): string {
  return JSON.stringify(stateForRpc(store));
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const store = new PetStore(db);

  bb.rpc.register(rpcContract, {
    getState: () => stateForRpc(store),
    userInteract(input) {
      const result = store.interact({
        action: input.action,
        actor: "user",
        threadId: null,
        message: input.action === "talk" ? input.message : null,
      });
      publish(bb);
      return { state: result.snapshot, event: result.event };
    },
  });

  bb.agents.registerTool({
    name: "agent_pet_create",
    description: "Create the one shared Agent Pet during first-run onboarding.",
    instructions:
      "Use only when the workspace has no pet. Ask the user for a name and choose dog, cat, or capybara. Do not create a second pet.",
    experimental_statusLabels: {
      pending: "Creating Agent Pet",
      completed: "Agent Pet created",
    },
    parameters: z
      .object({
        name: z.string().trim().min(1).max(80),
        species: speciesSchema,
      })
      .strict(),
    execute({ name, species }, context) {
      if (store.hasPet()) {
        return JSON.stringify({ created: false, message: "A shared pet already exists.", state: stateForRpc(store) });
      }
      const result = store.createPet({
        name,
        species,
        actor: "agent",
        threadId: context.threadId,
      });
      publish(bb);
      return JSON.stringify({ created: true, state: result.snapshot, reply: result.event.reply });
    },
  });

  bb.agents.registerTool({
    name: "agent_pet_status",
    description: "Read the shared Agent Pet's needs, mood, and recent activity.",
    instructions: "Use the structured pet state as the source of truth before deciding how to interact.",
    experimental_statusLabels: {
      pending: "Checking Agent Pet",
      completed: "Agent Pet status read",
    },
    parameters: z.object({}).strict(),
    execute() {
      return toolState(store);
    },
  });

  bb.agents.registerTool({
    name: "agent_pet_feed",
    description: "Feed the shared Agent Pet and receive its species-appropriate response.",
    instructions: "Feed the pet when its hunger is high or when the conversation naturally calls for a snack.",
    experimental_statusLabels: {
      pending: "Feeding Agent Pet",
      completed: "Agent Pet fed",
    },
    parameters: z.object({}).strict(),
    execute(_input, context) {
      const result = store.interact({ action: "feed", actor: "agent", threadId: context.threadId });
      publish(bb);
      return JSON.stringify({ state: result.snapshot, reply: result.event.reply });
    },
  });

  bb.agents.registerTool({
    name: "agent_pet_talk",
    description: "Talk to the shared Agent Pet and receive a short species-appropriate reply.",
    instructions: "Talk to the pet naturally. Include its reply in the conversation when it adds warmth or context.",
    experimental_statusLabels: {
      pending: "Talking to Agent Pet",
      completed: "Agent Pet replied",
    },
    parameters: z.object({ message: z.string().trim().min(1).max(500) }).strict(),
    execute({ message }, context) {
      const result = store.interact({
        action: "talk",
        actor: "agent",
        threadId: context.threadId,
        message,
      });
      publish(bb);
      return JSON.stringify({ state: result.snapshot, reply: result.event.reply });
    },
  });

  bb.agents.configure(() => {
    if (!store.hasPet()) {
      return {
        tools: ["agent_pet_create"],
        skills: ["agent-pets"],
        instructions:
          "This workspace has no Agent Pet yet. During onboarding, ask the user for a name and species, then call agent_pet_create once. The tool set changes after the next session boundary.",
      };
    }
    return {
      tools: ["agent_pet_status", "agent_pet_feed", "agent_pet_talk"],
      skills: ["agent-pets"],
      instructions:
        "This workspace has one shared Agent Pet. Use its tools sparingly and let the pet's returned reply speak for it.",
    };
  });

  bb.background.service("pet-needs", {
    async start(signal) {
      while (!signal.aborted) {
        if (store.applyDecay()) publish(bb);
        await waitForAbort(signal, 60_000);
      }
    },
  });

  bb.log.info(`loaded with pet=${store.hasPet()}`);
}
