import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set");
}

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Usage: node scripts/synthesize-openrouter.mjs <output.pcm>");
}

const model = process.env.OPENROUTER_TTS_MODEL ?? "google/gemini-3.1-flash-tts-preview";
const voice = process.env.OPENROUTER_TTS_VOICE ?? "Charon";
const responseFormat = process.env.OPENROUTER_TTS_FORMAT ?? (model.startsWith("google/") ? "pcm" : "mp3");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const transcriptPath = path.resolve(scriptDirectory, "../narration.txt");
const transcript = (await readFile(transcriptPath, "utf8")).trim();
const prompt = [
  "Read only the transcript below.",
  "Use a calm, warm, intelligent documentary narrator voice.",
  "Keep the pace conversational and measured, with a short pause between ideas.",
  "Avoid an announcer voice, exaggerated emphasis, and theatrical performance.",
  "Pronounce technical terms clearly: say S Q Lite, H T M L, U I, and i-frame.",
  "",
  "TRANSCRIPT:",
  transcript,
].join("\n");

const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://www.remotion.dev/",
    "X-Title": "Comprehension Remotion prototype",
  },
  body: JSON.stringify({
    model,
    input: prompt,
    voice,
    response_format: responseFormat,
  }),
});

if (!response.ok) {
  const detail = await response.text();
  throw new Error(`OpenRouter TTS failed (${response.status}): ${detail.slice(0, 500)}`);
}

const audio = Buffer.from(await response.arrayBuffer());
await writeFile(path.resolve(process.cwd(), outputPath), audio);
console.log(`Generated ${model} / ${voice} (${responseFormat}) → ${outputPath}`);
