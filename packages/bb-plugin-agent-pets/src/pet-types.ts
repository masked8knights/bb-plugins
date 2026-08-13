export const petSpecies = ["dog", "cat", "capybara"] as const;
export type PetSpecies = (typeof petSpecies)[number];

export const petActions = ["feed", "talk"] as const;
export type PetAction = (typeof petActions)[number];

export type PetActor = "agent" | "user" | "system";
export type PetMood = "hungry" | "sleepy" | "lonely" | "playful" | "content";

export interface PetRecord {
  id: string;
  name: string;
  species: PetSpecies;
  hunger: number;
  energy: number;
  happiness: number;
  createdAt: number;
  updatedAt: number;
  lastDecayAt: number;
}
export interface PetEvent {
  id: string;
  petId: string;
  action: "create" | PetAction;
  actor: PetActor;
  threadId: string | null;
  message: string | null;
  reply: string;
  createdAt: number;
}

export interface PetSnapshot {
  pet: PetRecord & { mood: PetMood };
  events: PetEvent[];
}

export interface PetInteractionResult {
  snapshot: PetSnapshot;
  event: PetEvent;
}

export function clampNeed(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function displayNeed(value: number): number {
  return Math.round(clampNeed(value));
}

export function deriveMood(pet: Pick<PetRecord, "hunger" | "energy" | "happiness">): PetMood {
  if (pet.hunger >= 72) return "hungry";
  if (pet.energy <= 22) return "sleepy";
  if (pet.happiness <= 30) return "lonely";
  if (pet.happiness >= 78 && pet.energy >= 58) return "playful";
  return "content";
}

export function speciesLabel(species: PetSpecies): string {
  return species[0].toUpperCase() + species.slice(1);
}
