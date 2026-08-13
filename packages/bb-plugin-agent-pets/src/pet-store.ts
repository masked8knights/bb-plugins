import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { creationReply, petReply } from "./pet-behavior";
import {
  clampNeed,
  deriveMood,
  displayNeed,
  type PetAction,
  type PetActor,
  type PetEvent,
  type PetInteractionResult,
  type PetRecord,
  type PetSnapshot,
  type PetSpecies,
} from "./pet-types";

export const SHARED_PET_ID = "shared-pet";

export const migrations = [
  `CREATE TABLE IF NOT EXISTS agent_pet (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     species TEXT NOT NULL,
     hunger REAL NOT NULL,
     energy REAL NOT NULL,
     happiness REAL NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_decay_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS agent_pet_events (
     id TEXT PRIMARY KEY,
     pet_id TEXT NOT NULL,
     action TEXT NOT NULL,
     actor TEXT NOT NULL,
     thread_id TEXT,
     message TEXT,
     reply TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     FOREIGN KEY (pet_id) REFERENCES agent_pet(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_pet_events_created
   ON agent_pet_events(pet_id, created_at DESC)`,
];

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function species(value: unknown): PetSpecies {
  return value === "dog" || value === "cat" ? value : "capybara";
}

function actor(value: unknown): PetActor {
  return value === "agent" || value === "user" ? value : "system";
}

function action(value: unknown): PetEvent["action"] {
  return value === "create" || value === "feed" || value === "talk" ? value : "talk";
}

function petFromRow(row: Row): PetRecord {
  return {
    id: text(row.id),
    name: text(row.name),
    species: species(row.species),
    hunger: numberValue(row.hunger),
    energy: numberValue(row.energy),
    happiness: numberValue(row.happiness),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    lastDecayAt: numberValue(row.last_decay_at),
  };
}

function eventFromRow(row: Row): PetEvent {
  return {
    id: text(row.id),
    petId: text(row.pet_id),
    action: action(row.action),
    actor: actor(row.actor),
    threadId: nullableText(row.thread_id),
    message: nullableText(row.message),
    reply: text(row.reply),
    createdAt: numberValue(row.created_at),
  };
}

export class PetStore {
  constructor(private readonly db: Database.Database) {}

  hasPet(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM agent_pet WHERE id = ? LIMIT 1").get(SHARED_PET_ID),
    );
  }

  getPet(): PetRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agent_pet WHERE id = ?")
      .get(SHARED_PET_ID) as Row | undefined;
    return row ? petFromRow(row) : null;
  }

  applyDecay(now = Date.now()): boolean {
    const pet = this.getPet();
    if (!pet) return false;
    const elapsedMs = Math.max(0, now - pet.lastDecayAt);
    if (elapsedMs < 30_000) return false;

    const elapsedMinutes = elapsedMs / 60_000;
    const nextHunger = clampNeed(pet.hunger + elapsedMinutes * 0.16);
    const nextEnergy = clampNeed(pet.energy - elapsedMinutes * 0.1);
    const nextHappiness = clampNeed(pet.happiness - elapsedMinutes * 0.07);
    this.db
      .prepare(
        `UPDATE agent_pet
         SET hunger = ?, energy = ?, happiness = ?, updated_at = ?, last_decay_at = ?
         WHERE id = ?`,
      )
      .run(nextHunger, nextEnergy, nextHappiness, now, now, SHARED_PET_ID);
    return true;
  }

  getState(now = Date.now()): PetSnapshot | null {
    this.applyDecay(now);
    const pet = this.getPet();
    if (!pet) return null;
    return this.snapshot(pet);
  }

  createPet(input: {
    name: string;
    species: PetSpecies;
    actor: PetActor;
    threadId: string | null;
    now?: number;
  }): PetInteractionResult {
    const now = input.now ?? Date.now();
    const name = input.name.trim();
    if (!name) throw new Error("Pet name cannot be empty");
    if (this.hasPet()) throw new Error("A shared pet already exists");

    const reply = creationReply(input.species, name);
    const eventId = randomUUID();
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_pet
           (id, name, species, hunger, energy, happiness, created_at, updated_at, last_decay_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(SHARED_PET_ID, name, input.species, 18, 84, 78, now, now, now);
      this.db
        .prepare(
          `INSERT INTO agent_pet_events
           (id, pet_id, action, actor, thread_id, message, reply, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          SHARED_PET_ID,
          "create",
          input.actor,
          input.threadId,
          `Created a ${input.species} named ${name}.`,
          reply,
          now,
        );
    });
    create();
    const snapshot = this.getState(now);
    if (!snapshot) throw new Error("Pet creation did not persist");
    return {
      snapshot,
      event: snapshot.events.find((event) => event.id === eventId) ?? {
        id: eventId,
        petId: SHARED_PET_ID,
        action: "create",
        actor: input.actor,
        threadId: input.threadId,
        message: `Created a ${input.species} named ${name}.`,
        reply,
        createdAt: now,
      },
    };
  }

  interact(input: {
    action: PetAction;
    actor: PetActor;
    threadId: string | null;
    message?: string | null;
    now?: number;
  }): PetInteractionResult {
    const now = input.now ?? Date.now();
    this.applyDecay(now);
    const pet = this.getPet();
    if (!pet) throw new Error("Create the shared pet before interacting with it");

    const mood = deriveMood(pet);
    const message = input.message?.trim() || null;
    const reply = petReply(
      pet.species,
      input.action,
      mood,
      `${pet.id}:${input.action}:${message ?? ""}:${now}`,
    );
    const next = {
      hunger: input.action === "feed" ? clampNeed(pet.hunger - 30) : pet.hunger,
      energy: input.action === "feed" ? clampNeed(pet.energy + 3) : clampNeed(pet.energy - 0.4),
      happiness: clampNeed(pet.happiness + (input.action === "feed" ? 8 : 4)),
    };
    const eventId = randomUUID();
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_pet
           SET hunger = ?, energy = ?, happiness = ?, updated_at = ?, last_decay_at = ?
           WHERE id = ?`,
        )
        .run(next.hunger, next.energy, next.happiness, now, now, SHARED_PET_ID);
      this.db
        .prepare(
          `INSERT INTO agent_pet_events
           (id, pet_id, action, actor, thread_id, message, reply, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, SHARED_PET_ID, input.action, input.actor, input.threadId, message, reply, now);
    });
    update();
    const snapshot = this.getState(now);
    if (!snapshot) throw new Error("Pet interaction did not persist");
    const event = snapshot.events.find((candidate) => candidate.id === eventId);
    if (!event) throw new Error("Pet interaction event did not persist");
    return { snapshot, event };
  }

  private snapshot(pet: PetRecord): PetSnapshot {
    const events = this.db
      .prepare(
         `SELECT * FROM agent_pet_events
         WHERE pet_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 30`,
      )
      .all(SHARED_PET_ID) as Row[];
    return {
      pet: {
        ...pet,
        hunger: displayNeed(pet.hunger),
        energy: displayNeed(pet.energy),
        happiness: displayNeed(pet.happiness),
        mood: deriveMood(pet),
      },
      events: events.map(eventFromRow),
    };
  }
}
