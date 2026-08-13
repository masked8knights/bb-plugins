import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { PetCanvas } from "./components/pet-canvas";
import {
  speciesLabel,
  type PetAction,
  type PetEvent,
  type PetMood,
  type PetRecord,
  type PetSnapshot,
} from "./src/pet-types";

type PetState = {
  pet: (PetSnapshot["pet"] & PetRecord) | null;
  events: PetEvent[];
};

const buttonClass =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClass =
  "inline-flex min-h-9 items-center justify-center rounded-md bg-foreground px-3 text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const inputClass =
  "h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring";

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function moodLabel(mood: PetMood): string {
  switch (mood) {
    case "hungry":
      return "Hungry";
    case "sleepy":
      return "Sleepy";
    case "lonely":
      return "A little lonely";
    case "playful":
      return "Playful";
    default:
      return "Content";
  }
}

function actionLabel(action: PetEvent["action"]): string {
  switch (action) {
    case "create":
      return "Arrived";
    case "feed":
      return "Fed";
    case "talk":
      return "Conversation";
  }
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{value}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function EmptyPetState() {
  return (
    <main className="min-h-full bg-background p-4 md:p-6">
      <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-3xl items-center justify-center">
        <section className="w-full border-y border-border py-12 text-center">
          <p className="text-4xl" aria-hidden="true">◌</p>
          <h1 className="mt-4 text-2xl font-medium tracking-tight text-foreground">Meet your companion</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            Ask your agent to create one shared pet. Choose a dog, cat, or capybara and give them a name.
          </p>
          <p className="mx-auto mt-6 max-w-md border border-border bg-muted/40 px-4 py-3 text-left font-mono text-xs leading-5 text-foreground">
            Create a capybara named Momo.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">Pet creation is available only during first-run onboarding.</p>
        </section>
      </div>
    </main>
  );
}

function PetRoom({ state, refresh }: { state: PetState; refresh: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<PetAction | null>(null);
  const [interactionKey, setInteractionKey] = useState(0);
  const [lastReply, setLastReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pet = state.pet;
  if (!pet) return <EmptyPetState />;

  const interact = async (input: { action: "feed" } | { action: "talk"; message: string }) => {
    setPendingAction(input.action);
    setError(null);
    try {
      const result = await rpc.call("userInteract", input);
      setLastReply(result.event.reply);
      setInteractionKey((value) => value + 1);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <main className="min-h-full overflow-y-auto bg-background p-4 md:p-6">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-foreground">{pet.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{speciesLabel(pet.species)} · {moodLabel(pet.mood)}</p>
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {lastReply ?? "Your shared companion is here."}
          </p>
        </div>

        <section className="overflow-hidden border border-border" aria-label={`${pet.name} 3D scene`}>
          <div className="relative min-h-[360px] overflow-hidden bg-gradient-to-br from-secondary via-muted to-accent md:min-h-[480px]">
            <PetCanvas species={pet.species} action={pendingAction} interactionKey={interactionKey} />
            <div className="pointer-events-none absolute left-4 top-4 border border-border/70 bg-background/70 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
              shared companion · {speciesLabel(pet.species).toLowerCase()}
            </div>
            <div className="pointer-events-none absolute bottom-4 right-4 max-w-[min(24rem,calc(100%-2rem))] border border-border/70 bg-background/75 px-3 py-2 text-sm text-foreground backdrop-blur-sm" aria-live="polite">
              {lastReply ?? "I am here. Take your time."}
            </div>
          </div>

          <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-3">
            <Meter label="Hunger" value={pet.hunger} />
            <Meter label="Energy" value={pet.energy} />
            <Meter label="Happiness" value={pet.happiness} />
          </div>
        </section>

        <section className="border-y border-border py-4" aria-labelledby="pet-actions-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="pet-actions-heading" className="text-sm font-medium text-foreground">Spend a moment together</h2>
              <p className="mt-1 text-xs text-muted-foreground">These actions are recorded as user interactions.</p>
            </div>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={pendingAction !== null}
              onClick={() => void interact({ action: "feed" })}
            >
              {pendingAction === "feed" ? "Feeding…" : "Feed"}
            </button>
          </div>
          <form
            className="mt-3 flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = message.trim();
              if (!next || pendingAction !== null) return;
              setMessage("");
              void interact({ action: "talk", message: next });
            }}
          >
            <label className="sr-only" htmlFor="agent-pet-message">Say something to {pet.name}</label>
            <input
              id="agent-pet-message"
              className={inputClass}
              value={message}
              maxLength={500}
              placeholder={`Say something to ${pet.name}`}
              onChange={(event) => setMessage(event.target.value)}
              disabled={pendingAction !== null}
            />
            <button type="submit" className={buttonClass} disabled={!message.trim() || pendingAction !== null}>
              {pendingAction === "talk" ? "Listening…" : "Talk"}
            </button>
          </form>
          {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
        </section>

        <section aria-labelledby="pet-history-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="pet-history-heading" className="text-sm font-medium text-foreground">Recent moments</h2>
            <span className="text-xs text-muted-foreground">Live updates enabled</span>
          </div>
          <ol className="mt-2 divide-y divide-border border-y border-border">
            {state.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    <span className="font-medium">{event.actor === "agent" ? "Agent" : event.actor === "user" ? "You" : "Pet"}</span>
                    <span className="text-muted-foreground"> · {actionLabel(event.action)}</span>
                  </p>
                  {event.message ? <p className="mt-1 truncate text-xs text-muted-foreground">“{event.message}”</p> : null}
                  <p className="mt-1 text-sm text-foreground">{event.reply}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  <time dateTime={new Date(event.createdAt).toISOString()}>{formatTime(event.createdAt)}</time>
                  {event.threadId ? (
                    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.toThread(event.threadId!)}>
                      Open thread
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

function AgentPetsPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<PetState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("getState", null);
      setState(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("agent-pets", () => {
    void refresh();
  });

  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);

  if (loading && !state) {
    return <main className="grid min-h-full place-items-center bg-background p-6 text-sm text-muted-foreground">Loading companion…</main>;
  }
  if (error && !state) {
    return (
      <main className="grid min-h-full place-items-center bg-background p-6">
        <div className="max-w-md text-center">
          <p className="text-sm text-destructive" role="alert">{error}</p>
          <button type="button" className={`${buttonClass} mt-4`} onClick={() => void refresh()}>Retry</button>
        </div>
      </main>
    );
  }
  if (!state) return null;
  return <PetRoom state={state} refresh={refresh} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-pets",
    title: "Agent Pets",
    icon: "Heart",
    path: "pets",
    component: AgentPetsPanel,
  });
});
