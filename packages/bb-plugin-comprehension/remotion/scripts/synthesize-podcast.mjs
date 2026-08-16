import {readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set");
}

const outputPath = process.argv[2];
const timingPath = process.argv[3];
if (!outputPath || !timingPath) {
  throw new Error("Usage: node scripts/synthesize-podcast.mjs <output.pcm> <timings.json>");
}

const model = process.env.OPENROUTER_TTS_MODEL ?? "google/gemini-3.1-flash-tts-preview";
const hostVoice = process.env.OPENROUTER_PODCAST_HOST_VOICE ?? "Charon";
const explainerVoice = process.env.OPENROUTER_PODCAST_EXPLAINER_VOICE ?? "Sulafat";
const responseFormat = process.env.OPENROUTER_TTS_FORMAT ?? (model.startsWith("google/") ? "pcm" : "mp3");
const sampleRate = 24000;
const channels = 1;
const bytesPerSample = 2;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const transcriptPath = path.resolve(scriptDirectory, "../podcast-script.txt");
const transcript = (await readFile(transcriptPath, "utf8")).trim();
const turns = transcript.split(/\r?\n/).map((line, index) => {
  const separator = line.indexOf(":");
  if (separator < 1) {
    throw new Error(`Invalid podcast line ${index + 1}`);
  }
  const role = line.slice(0, separator).trim();
  const text = line.slice(separator + 1).trim();
  if (role !== "HOST" && role !== "EXPLAINER") {
    throw new Error(`Unsupported podcast role on line ${index + 1}: ${role}`);
  }
  return {role, text};
});

const roleInstructions = {
  HOST: [
    "Read only the text after TEXT.",
    "You are a thoughtful, skeptical engineer returning to a project after an agent finished work.",
    "Sound curious, direct, and human. Ask a real question. Do not sound like an announcer or actor.",
  ].join(" "),
  EXPLAINER: [
    "Read only the text after TEXT.",
    "You are a calm, precise colleague explaining a technical system to a product-minded engineer.",
    "Sound patient, conversational, and specific. Do not sound like a narrator or a sales pitch.",
    "Pronounce technical terms clearly: say H T M L, S Q Lite, U I, and i-frame.",
  ].join(" "),
};

async function synthesizeTurn(turn, index) {
  const voice = turn.role === "HOST" ? hostVoice : explainerVoice;
  const input = [
    roleInstructions[turn.role],
    "",
    "TEXT:",
    turn.text,
  ].join("\n");
  const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://www.remotion.dev/",
      "X-Title": "Comprehension podcast prototype",
    },
    body: JSON.stringify({
      model,
      input,
      voice,
      response_format: responseFormat,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenRouter TTS failed for turn ${index + 1} (${response.status}): ${detail.slice(0, 500)}`);
  }

  return {
    ...turn,
    voice,
    audio: Buffer.from(await response.arrayBuffer()),
  };
}

const generatedTurns = await Promise.all(turns.map(synthesizeTurn));
const pauseBytes = (seconds) => Buffer.alloc(Math.round(sampleRate * channels * bytesPerSample * seconds));
const chunks = [];
const timings = [];
let byteOffset = 0;

for (const [index, turn] of generatedTurns.entries()) {
  const duration = turn.audio.length / (sampleRate * channels * bytesPerSample);
  const start = byteOffset / (sampleRate * channels * bytesPerSample);
  chunks.push(turn.audio);
  byteOffset += turn.audio.length;
  const end = byteOffset / (sampleRate * channels * bytesPerSample);
  timings.push({
    index,
    role: turn.role,
    voice: turn.voice,
    text: turn.text,
    start,
    end,
    duration,
  });

  if (index < generatedTurns.length - 1) {
    const pause = turn.role === "HOST" ? 0.32 : 0.58;
    const silence = pauseBytes(pause);
    chunks.push(silence);
    byteOffset += silence.length;
  }
}

const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
const resolvedTimingPath = path.resolve(process.cwd(), timingPath);
await writeFile(resolvedOutputPath, Buffer.concat(chunks));
await writeFile(
  resolvedTimingPath,
  JSON.stringify({model, sampleRate, channels, bytesPerSample, turns: timings}, null, 2) + "\n",
);

const totalDuration = byteOffset / (sampleRate * channels * bytesPerSample);
console.log(`Generated ${turns.length} podcast turns with ${hostVoice} / ${explainerVoice} (${responseFormat})`);
console.log(`PCM: ${resolvedOutputPath}`);
console.log(`Timings: ${resolvedTimingPath}`);
console.log(`Duration: ${totalDuration.toFixed(2)} seconds`);
