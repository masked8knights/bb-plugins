import type { PetAction, PetMood, PetSpecies } from "./pet-types";

const replies: Record<PetSpecies, Record<PetAction, string[]>> = {
  dog: {
    feed: [
      "Woof! That hit the spot.",
      "Tail wag activated. Thank you for the snack.",
      "Mmm. I will save one happy thought for later.",
    ],
    talk: [
      "Woof. I am listening with both ears.",
      "That sounds important. I am right here.",
      "I agree, especially if we can go somewhere together afterward.",
    ],
  },
  cat: {
    feed: [
      "Mrrp. I accept this offering.",
      "Purr. Your timing is acceptable.",
      "I have eaten. You may admire me now.",
    ],
    talk: [
      "Mrrp. I have considered your words.",
      "Prrr. Continue. This is interesting enough.",
      "I understand. I will sit here and supervise calmly.",
    ],
  },
  capybara: {
    feed: [
      "Mmm. A calm snack for a calm day.",
      "That was peaceful. I enjoyed it.",
      "Crunch. We can take the rest of the day slowly.",
    ],
    talk: [
      "That sounds nice. Let us take it slowly.",
      "I hear you. The day can be gentle.",
      "Mmm-hm. I am staying right here with you.",
    ],
  },
};

const moodPrefixes: Record<PetMood, string> = {
  hungry: "I am thinking about food. ",
  sleepy: "I am a little sleepy. ",
  lonely: "I am glad you are here. ",
  playful: "I feel bright today. ",
  content: "",
};

function stableIndex(seed: string, length: number): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % length;
}
export function petReply(
  species: PetSpecies,
  action: PetAction,
  mood: PetMood,
  seed: string,
): string {
  const options = replies[species][action];
  return `${moodPrefixes[mood]}${options[stableIndex(seed, options.length)]}`;
}

export function creationReply(species: PetSpecies, name: string): string {
  switch (species) {
    case "dog":
      return `${name} is here and already wagging. I am ready to meet them.`;
    case "cat":
      return `${name} has arrived and is assessing the room. Please be patient.`;
    case "capybara":
      return `${name} has settled in. Everything feels pleasantly unhurried.`;
  }
}
