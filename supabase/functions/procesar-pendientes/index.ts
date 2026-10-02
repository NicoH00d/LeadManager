// Red de seguridad, llamada cada minuto por pg_cron: responde a leads cuyo
// plazo de respuesta ya venció y nadie atendió (p. ej. falló el LLM o se
// cortó la función del webhook).
import { db } from "../_shared/db.ts";
import { requerida } from "../_shared/env.ts";
import { responderLead } from "../_shared/responder.ts";

// Margen para no competir con el webhook, que responde unos segundos después del plazo.
const MARGEN_SEGUNDOS = 30;

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== requerida("CRON_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const limite = new Date(Date.now() - MARGEN_SEGUNDOS * 1000).toISOString();
  const { data, error } = await db
    .from("leads")
    .select("id")
    .lte("responder_a_partir_de", limite)
    .not("estado", "in", "(humano_activo,bloqueado)")
    .limit(20);
  if (error) return new Response(error.message, { status: 500 });

  await Promise.all(data.map((l) => responderLead(l.id)));
  return Response.json({ procesados: data.length });
});
