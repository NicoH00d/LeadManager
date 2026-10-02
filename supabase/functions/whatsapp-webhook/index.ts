// Webhook de WhatsApp Cloud API.
// GET  -> verificación del webhook (Meta manda hub.challenge).
// POST -> mensajes entrantes y actualizaciones de estado de los enviados.
//
// Responde 200 de inmediato y procesa en segundo plano: Meta reintenta si
// tardamos, y los reintentos se descartan gracias a `wa_message_id` único.
import { BUCKET_MEDIA, db } from "../_shared/db.ts";
import { config, requerida } from "../_shared/env.ts";
import { descargarMedia, firmaValida } from "../_shared/whatsapp.ts";
import { transcribir } from "../_shared/transcribir.ts";
import { responderLead } from "../_shared/responder.ts";

declare const EdgeRuntime: { waitUntil(promesa: Promise<unknown>): void };

// deno-lint-ignore no-explicit-any
type Json = any;

Deno.serve(async (req) => {
  if (req.method === "GET") return verificar(new URL(req.url));
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const cuerpo = await req.text();
  if (!(await firmaValida(cuerpo, req.headers.get("x-hub-signature-256")))) {
    return new Response("Firma inválida", { status: 401 });
  }

  EdgeRuntime.waitUntil(
    procesar(JSON.parse(cuerpo)).catch((e) => console.error("Error procesando webhook:", e)),
  );
  return new Response("ok");
});

function verificar(url: URL): Response {
  const p = url.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === requerida("WHATSAPP_VERIFY_TOKEN")) {
    return new Response(p.get("hub.challenge") ?? "");
  }
  return new Response("Forbidden", { status: 403 });
}

async function procesar(payload: Json): Promise<void> {
  const leadsConMensajes = new Set<string>();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      for (const status of value.statuses ?? []) await actualizarEstado(status);

      const nombres = new Map<string, string>(
        (value.contacts ?? []).map((c: Json) => [c.wa_id, c.profile?.name]),
      );
      for (const msg of value.messages ?? []) {
        const leadId = await guardarEntrante(msg, nombres.get(msg.from));
        if (leadId) leadsConMensajes.add(leadId);
      }
    }
  }

  // Agrupación: esperar por si llegan más mensajes y luego intentar responder.
  // Si llega otro mensaje en la espera, éste empuja el plazo y su propia
  // invocación será la que responda (ver reclamar_respuesta en SQL).
  if (leadsConMensajes.size === 0) return;
  await new Promise((r) => setTimeout(r, config.debounceMs() + 500));
  await Promise.all([...leadsConMensajes].map(responderLead));
}

const MAPA_ESTADOS: Record<string, string> = {
  sent: "enviado",
  delivered: "entregado",
  read: "leido",
  failed: "fallido",
};

async function actualizarEstado(status: Json): Promise<void> {
  const estado = MAPA_ESTADOS[status.status];
  if (!estado) return;
  if (status.status === "failed") console.error("Mensaje fallido en WhatsApp:", JSON.stringify(status.errors));
  await db.from("mensajes").update({ estado_envio: estado }).eq("wa_message_id", status.id);
}

/** Guarda un mensaje entrante. Regresa el id del lead, o null si era duplicado o se ignora. */
async function guardarEntrante(msg: Json, nombre?: string): Promise<string | null> {
  if (msg.type === "reaction" || msg.type === "unsupported") return null;

  // 1. Lead (se crea si es nuevo)
  const datosLead: Json = { telefono: `+${msg.from}` };
  if (nombre) datosLead.nombre = nombre;
  if (msg.referral) {
    datosLead.referral = msg.referral;
    if (msg.referral.ctwa_clid) datosLead.ctwa_clid = msg.referral.ctwa_clid;
  }
  const { data: lead, error: errLead } = await db
    .from("leads")
    .upsert(datosLead, { onConflict: "telefono" })
    .select("id, estado")
    .single();
  if (errLead) throw errLead;

  // 2. Mensaje (idempotente por wa_message_id)
  const { tipo, contenido, mediaId } = extraer(msg);
  const { data: guardado, error: errMsg } = await db
    .from("mensajes")
    .upsert(
      { lead_id: lead.id, direccion: "entrante", autor: "lead", tipo, contenido, wa_message_id: msg.id },
      { onConflict: "wa_message_id", ignoreDuplicates: true },
    )
    .select("id");
  if (errMsg) throw errMsg;
  if (!guardado?.length) return null; // reintento de Meta: ya lo teníamos

  // 3. Audio / imagen / documento
  if (mediaId) {
    try {
      await guardarMedia(lead.id, guardado[0].id, mediaId, tipo);
    } catch (e) {
      console.error(`No se pudo procesar media ${mediaId}:`, e);
    }
  }

  // 4. Ventana de 24 h y plazo para responder (agrupación de mensajes)
  const ahora = Date.now();
  const cambios: Json = {
    ultimo_mensaje_lead_at: new Date(ahora).toISOString(),
    responder_a_partir_de: new Date(ahora + config.debounceMs()).toISOString(),
  };
  if (lead.estado === "sin_respuesta") cambios.estado = "en_progreso";
  await db.from("leads").update(cambios).eq("id", lead.id);

  return lead.id;
}

function extraer(msg: Json): { tipo: string; contenido: string | null; mediaId?: string } {
  switch (msg.type) {
    case "text":
      return { tipo: "texto", contenido: msg.text?.body ?? null };
    case "audio":
      return { tipo: "audio", contenido: null, mediaId: msg.audio?.id };
    case "image":
      return { tipo: "imagen", contenido: msg.image?.caption ?? null, mediaId: msg.image?.id };
    case "document":
      return {
        tipo: "documento",
        contenido: msg.document?.caption ?? msg.document?.filename ?? null,
        mediaId: msg.document?.id,
      };
    case "button":
      return { tipo: "texto", contenido: msg.button?.text ?? null };
    case "interactive":
      return {
        tipo: "texto",
        contenido: msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null,
      };
    case "location":
      return {
        tipo: "otro",
        contenido: `[ubicación] ${msg.location?.name ?? ""} ${msg.location?.address ?? ""}`.trim(),
      };
    case "sticker":
      return { tipo: "otro", contenido: "[sticker]" };
    default:
      return { tipo: "otro", contenido: `[mensaje de tipo ${msg.type}]` };
  }
}

async function guardarMedia(leadId: string, mensajeId: string, mediaId: string, tipo: string): Promise<void> {
  const { bytes, mimeType } = await descargarMedia(mediaId);
  const extension = mimeType.split("/")[1]?.split(";")[0] ?? "bin";
  const ruta = `${leadId}/${mediaId}.${extension}`;

  const { error } = await db.storage.from(BUCKET_MEDIA).upload(ruta, bytes, { contentType: mimeType, upsert: true });
  if (error) throw error;

  const cambios: Json = { media_url: ruta };
  if (tipo === "audio") cambios.transcripcion = await transcribir(bytes, mimeType);
  await db.from("mensajes").update(cambios).eq("id", mensajeId);
}
