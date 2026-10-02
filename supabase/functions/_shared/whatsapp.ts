// Cliente mínimo de la WhatsApp Cloud API (Meta Graph API).
import { config, requerida } from "./env.ts";

const graphUrl = (ruta: string) =>
  `https://graph.facebook.com/${config.graphVersion()}/${ruta}`;

const authHeader = () => ({ Authorization: `Bearer ${requerida("WHATSAPP_ACCESS_TOKEN")}` });

/** Verifica el header X-Hub-Signature-256 (HMAC-SHA256 del body con el App Secret). */
export async function firmaValida(cuerpo: string, firma: string | null): Promise<boolean> {
  if (!firma?.startsWith("sha256=")) return false;
  const llave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requerida("WHATSAPP_APP_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", llave, new TextEncoder().encode(cuerpo));
  const esperado = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const recibido = firma.slice("sha256=".length);
  // Comparación en tiempo constante
  if (recibido.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < esperado.length; i++) diff |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i);
  return diff === 0;
}

/** Descarga un archivo (audio, imagen, documento) a partir de su media id. */
export async function descargarMedia(
  mediaId: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> {
  const meta = await fetch(graphUrl(mediaId), { headers: authHeader() });
  if (!meta.ok) throw new Error(`Graph media ${mediaId}: ${meta.status} ${await meta.text()}`);
  const { url, mime_type } = await meta.json();

  const archivo = await fetch(url, { headers: authHeader() });
  if (!archivo.ok) throw new Error(`Descarga media ${mediaId}: ${archivo.status}`);
  return { bytes: new Uint8Array(await archivo.arrayBuffer()), mimeType: mime_type };
}

/** Envía un mensaje de texto. Regresa el id del mensaje en WhatsApp. */
export async function enviarTexto(telefono: string, texto: string): Promise<string> {
  const res = await fetch(graphUrl(`${requerida("WHATSAPP_PHONE_NUMBER_ID")}/messages`), {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefono.replace(/^\+/, ""),
      type: "text",
      text: { body: texto, preview_url: false },
    }),
  });
  if (!res.ok) throw new Error(`Envío WhatsApp: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.messages?.[0]?.id;
}
