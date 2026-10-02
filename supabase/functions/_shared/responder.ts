// Arma el historial de un lead, pide la respuesta al bot y la envía (o la deja
// como borrador en modo sombra).
import type Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { BUCKET_MEDIA, db } from "./db.ts";
import { config } from "./env.ts";
import { type ArticuloKB, generarRespuesta } from "./bot.ts";
import { enviarTexto } from "./whatsapp.ts";

const LIMITE_HISTORIAL = 40;
const REINTENTO_SEGUNDOS = 60;
const IMAGENES_SOPORTADAS = ["image/jpeg", "image/png", "image/gif", "image/webp"];

interface Mensaje {
  id: string;
  direccion: "entrante" | "saliente";
  autor: "lead" | "bot" | "humano" | "sistema";
  tipo: string;
  contenido: string | null;
  transcripcion: string | null;
  media_url: string | null;
  procesado: boolean;
  created_at: string;
}

/**
 * Intenta responder a un lead. Si otro proceso ya reclamó el turno, o llegó
 * un mensaje más nuevo que todavía está en espera, no hace nada.
 */
export async function responderLead(leadId: string): Promise<void> {
  const { data: reclamado, error } = await db.rpc("reclamar_respuesta", { p_lead_id: leadId });
  if (error) throw error;
  if (!reclamado) return;

  const inicio = new Date().toISOString();
  try {
    await responder(leadId, inicio);
  } catch (e) {
    console.error(`Error respondiendo al lead ${leadId}:`, e);
    // Lo deja pendiente para que `procesar-pendientes` lo reintente.
    await db
      .from("leads")
      .update({ responder_a_partir_de: new Date(Date.now() + REINTENTO_SEGUNDOS * 1000).toISOString() })
      .eq("id", leadId)
      .is("responder_a_partir_de", null);
  }
}

async function responder(leadId: string, inicio: string): Promise<void> {
  const [{ data: lead, error: errLead }, { data: historial, error: errHist }, { data: kb, error: errKb }] =
    await Promise.all([
      db.from("leads").select("id, telefono, nombre, estado").eq("id", leadId).single(),
      db
        .from("mensajes")
        .select("id, direccion, autor, tipo, contenido, transcripcion, media_url, procesado, created_at")
        .eq("lead_id", leadId)
        .or("estado_envio.is.null,estado_envio.not.in.(borrador,rechazado,fallido)")
        .order("created_at", { ascending: false })
        .limit(LIMITE_HISTORIAL),
      db.from("knowledge_base").select("categoria, titulo, contenido").eq("activo", true).order("categoria"),
    ]);
  if (errLead) throw errLead;
  if (errHist) throw errHist;
  if (errKb) throw errKb;

  const mensajes = (historial as Mensaje[]).reverse();
  const pendientes = mensajes.filter((m) => m.direccion === "entrante" && !m.procesado);
  if (pendientes.length === 0) return;

  const salida = await generarRespuesta(kb as ArticuloKB[], await aMensajesClaude(mensajes));

  // Guardar (y enviar) la respuesta
  if (salida.respuesta.trim()) {
    const modo = config.botModo();
    const { data: guardado, error } = await db
      .from("mensajes")
      .insert({
        lead_id: leadId,
        direccion: "saliente",
        autor: "bot",
        tipo: "texto",
        contenido: salida.respuesta,
        estado_envio: modo === "sombra" ? "borrador" : "aprobado",
      })
      .select("id")
      .single();
    if (error) throw error;

    if (modo === "auto") {
      try {
        const waId = await enviarTexto(lead.telefono, salida.respuesta);
        await db.from("mensajes").update({ wa_message_id: waId, estado_envio: "enviado" }).eq("id", guardado.id);
      } catch (e) {
        await db.from("mensajes").update({ estado_envio: "fallido" }).eq("id", guardado.id);
        throw e;
      }
    }
  }

  await db
    .from("mensajes")
    .update({ procesado: true })
    .in("id", pendientes.map((m) => m.id))
    .lte("created_at", inicio);

  if (salida.escalar_a_humano) {
    await db
      .from("leads")
      .update({ estado: "humano_activo", accion: "llamada_humana", accion_razon: salida.motivo })
      .eq("id", leadId);
    // TODO (Chatwoot): notificar al equipo y asignar la conversación.
    console.log(`Lead ${leadId} escalado a humano: ${salida.motivo}`);
  }
}

/** Convierte el historial guardado al formato de mensajes de Claude. */
async function aMensajesClaude(mensajes: Mensaje[]): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const resultado: Anthropic.Beta.BetaMessageParam[] = [];

  for (const m of mensajes) {
    const rol = m.direccion === "entrante" ? "user" : "assistant";
    // La API exige que la conversación empiece con el usuario.
    if (resultado.length === 0 && rol === "assistant") continue;

    const bloques: Anthropic.Beta.BetaContentBlockParam[] = [];

    if (rol === "user" && m.tipo === "imagen" && m.media_url && !m.procesado) {
      // Solo se mandan las imágenes nuevas; las viejas van como texto para ahorrar tokens.
      const imagen = await imagenBase64(m.media_url);
      if (imagen) bloques.push({ type: "image", source: { type: "base64", ...imagen } });
    }

    const texto = textoDeMensaje(m);
    if (texto) bloques.push({ type: "text", text: texto });
    if (bloques.length === 0) continue;

    // Mensajes seguidos del mismo rol se combinan en un solo turno.
    const ultimo = resultado.at(-1);
    if (ultimo && ultimo.role === rol && Array.isArray(ultimo.content)) {
      ultimo.content.push(...bloques);
    } else {
      resultado.push({ role: rol, content: bloques });
    }
  }
  return resultado;
}

function textoDeMensaje(m: Mensaje): string {
  if (m.direccion === "saliente") {
    const prefijo = m.autor === "humano" ? "[respuesta del equipo] " : "";
    return m.contenido ? prefijo + m.contenido : "";
  }
  switch (m.tipo) {
    case "audio":
      return m.transcripcion
        ? `[nota de voz]: ${m.transcripcion}`
        : "[nota de voz que no se pudo transcribir]";
    case "imagen":
      return m.contenido ? `[imagen] ${m.contenido}` : "[imagen]";
    case "documento":
      return m.contenido ? `[documento] ${m.contenido}` : "[documento]";
    default:
      return m.contenido ?? "";
  }
}

async function imagenBase64(
  ruta: string,
): Promise<{ media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } | null> {
  const { data, error } = await db.storage.from(BUCKET_MEDIA).download(ruta);
  if (error || !data) return null;
  const tipo = data.type.split(";")[0];
  if (!IMAGENES_SOPORTADAS.includes(tipo)) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { media_type: tipo as "image/jpeg", data: btoa(binario) };
}
