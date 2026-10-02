// Transcripción de notas de voz. Claude no procesa audio, así que se usa
// la API de transcripción de OpenAI. Si no hay OPENAI_API_KEY, regresa null
// y el bot le pide al lead que escriba su mensaje.
import { config } from "./env.ts";

export async function transcribir(bytes: Uint8Array<ArrayBuffer>, mimeType: string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return null;

  const extension = mimeType.includes("ogg") ? "ogg" : mimeType.split("/")[1]?.split(";")[0] ?? "ogg";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), `audio.${extension}`);
  form.append("model", config.transcripcionModelo());
  form.append("language", "es");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    console.error("Transcripción falló:", res.status, await res.text());
    return null;
  }
  const { text } = await res.json();
  return text?.trim() || null;
}
