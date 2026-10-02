// Lectura centralizada de variables de entorno (Supabase > Edge Functions > Secrets).

export function requerida(nombre: string): string {
  const valor = Deno.env.get(nombre);
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre}`);
  return valor;
}

export function opcional(nombre: string, porDefecto: string): string {
  return Deno.env.get(nombre) || porDefecto;
}

export const config = {
  graphVersion: () => opcional("GRAPH_API_VERSION", "v23.0"),
  llmModelo: () => opcional("LLM_MODEL", "claude-haiku-4-5"),
  // Solo aplica a modelos que soportan `effort` (no Haiku 4.5); ver bot.ts.
  llmEffort: () => opcional("LLM_EFFORT", "low") as "low" | "medium" | "high",
  transcripcionModelo: () => opcional("TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
  // auto: el bot envía directo. sombra: guarda borradores para que un humano los apruebe.
  botModo: () => opcional("BOT_MODO", "auto") as "auto" | "sombra",
  debounceMs: () => Number(opcional("DEBOUNCE_MS", "8000")),
};
