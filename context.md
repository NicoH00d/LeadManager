# Proyecto Tovlov: IA para gestión de leads de WhatsApp

## Contexto del negocio
Tovlov organiza eventos de matchmaking para personas mayores de 40 años. Sacan campañas de marketing (ads) que generan un volumen alto de leads por WhatsApp. El problema: llegan muchas preguntas, audios, y mensajes de gente con baja intención real de compra o actitud problemática (bravuconería tipo "a mí me conocen en todos los antros"). El equipo humano pierde tiempo filtrando manualmente.

## Objetivo del proyecto
Automatizar la conversación inicial con IA para que:
1. Responda dudas del lead en WhatsApp.
2. Califique al lead conversando de forma natural, sin interrogarlo.
3. Decida la acción (inscribir, pasar a humano, nutrir, descartar…) y, cuando aplique, **cierre la venta en el mismo chat** con link de pago.
4. Le avise a Meta qué leads sí valen, para que los anuncios traigan leads de mejor calidad desde el origen.

El objetivo de fondo es **vender más con menos tiempo humano**, no solo filtrar.

## Cómo funciona

**1. Entrada**
Lead escribe por WhatsApp Business (API de Meta) → webhook recibe el mensaje.
- **Audio** → se transcribe antes de procesar.
- **Imagen** → la IA la interpreta (caso clave: comprobantes de pago).
- **Agrupar mensajes:** se espera ~5–10 s tras el último mensaje antes de responder, para contestar "hola" + "una pregunta" + audio como un solo turno.
- **Atribución:** si el lead viene de un anuncio Click-to-WhatsApp, se guarda el `referral` / `ctwa_clid` para reportar conversiones a Meta (ver paso 8).

**2. Check de historial**
Antes de responder, se busca al lead (teléfono normalizado como llave) en `client_history`: asistencias pasadas, incidentes reportados por el staff. Si tiene un flag negativo (ej. la clienta que se llevó a otras a otro lado), se salta la conversación y va directo a `llamada_humana` o `descartar`.

**3. Conversación con IA**
Si no hay flag previo, la IA conversa con una regla simple: **primero responde lo que el lead preguntó, luego hace UNA pregunta de calificación.** Nunca contestar una pregunta con otra.

No hay un número fijo de turnos. La conversación termina cuando la ficha del lead (paso 4) está suficientemente completa o la señal ya es clara (ej. hostilidad desde el mensaje 1). Pueden ser 2 mensajes o 7.

Las respuestas se basan en una **base de conocimiento editable por el staff** (precios, fechas, sedes, políticas, FAQ) guardada en una tabla o documento, no escrita dentro del prompt. El bot nunca promete nada que no esté ahí; si no sabe, pasa a humano.

El bot se presenta como asistente de Tovlov (no finge ser una persona). Tono cálido y paciente, pensado para un público de 40+.

**4. Ficha del lead (evaluación en cada turno)**
En cada turno la IA devuelve, con output estructurado (JSON):
- `respuesta`: el mensaje para el lead.
- `ficha`: el perfil actualizado del lead.

Campos de la ficha:
- `rango_edad`, `ciudad`, `evento_interes`, `conoce_precio`, `objeciones`
- `intencion` (0–1) + evidencia
- `riesgo` (0–1) + evidencia (bravuconería, hostilidad, señales de mal comportamiento)
- `confianza` de la IA en su lectura
- `accion_sugerida` + `razon`

Así no hay un paso de "evaluación final" aparte: la decisión sale de la ficha en cuanto hay suficiente señal, y siempre queda registrado el porqué. Para calibrar se usan ejemplos few-shot sacados del historial real de chats de Tovlov.

**5. Decisión: matriz intención × riesgo**

| | Riesgo bajo | Riesgo alto |
|---|---|---|
| **Intención alta** | `inscribir_directo` | `llamada_humana` |
| **Intención baja** | `nutrir` | `descartar` |

El caso "a mí me conocen en todos los antros" suele tener intención alta y riesgo alto: lo decide un humano, no se descarta automáticamente.

Acciones posibles:
- `inscribir_directo`: se manda link de pago en el chat.
- `llamada_humana`: se notifica al equipo.
- `nutrir`: entra a la cola de seguimiento con plantillas.
- `descartar`: cierre amable; nunca se deja al lead sin respuesta.
- `no_califica`: no cumple el perfil (ej. menor de 40); respuesta amable, distinto de descartar.
- `lista_espera`: el evento está lleno; se le avisa del siguiente.

Si la `confianza` es baja, la acción por defecto es `llamada_humana`.

**6. Estado de la conversación**
Se guarda en la db un estado por lead:
- `en_progreso`: la IA sigue conversando.
- `humano_activo`: alguien del staff tomó la conversación; el bot se pausa.
- `esperando_pago`: se mandó link de pago.
- `inscrito`: pago confirmado (pasarela o comprobante validado).
- `sin_respuesta`: el lead dejó de contestar.
- `resuelto`: ya tiene acción final asignada.
- `bloqueado`: no se le vuelve a responder automáticamente.

**7. Cobro en el chat**
Para `inscribir_directo`, el bot manda link de pago (Mercado Pago / Stripe / referencia OXXO). La confirmación llega por webhook de la pasarela o por foto del comprobante (revisada por la IA y, en caso de duda, por un humano). Al confirmarse → `inscrito` + mensaje con los detalles del evento.

**8. Retroalimentación a Meta (Conversions API)**
Cuando un lead califica (`intencion` alta) o paga, se envía un evento a la Conversions API de Meta con el `ctwa_clid`. Así Meta optimiza los anuncios para traer gente parecida a la que sí compra, y se ataca el problema de leads de baja calidad desde la raíz.

**9. Notificación, paso a humano y ventana de 24 h**
- **Bandeja compartida:** se usa Chatwoot (open source, se conecta a la API de WhatsApp) u otra herramienta similar en lugar de construir una bandeja propia. Si un humano escribe en la conversación, el bot pasa a `humano_activo` y deja de responder.
- **`llamada_humana`** → notificación al equipo con la ficha del lead y un resumen.
- **Ventana de 24 h de Meta:** solo se pueden mandar mensajes libres dentro de las 24 h posteriores al último mensaje del lead. Pasado ese plazo, únicamente plantillas aprobadas (con costo).
  - Si el lead deja de contestar, se manda un recordatorio antes de que cierre la ventana (~hora 22).
  - `nutrir` se diseña desde el principio con plantillas aprobadas (ej. aviso de próximo evento, promoción).

**10. Loop de retroalimentación interno**
- El staff reporta incidentes post-evento (formulario simple) → alimenta `client_history`.
- Se registra el resultado real de cada lead (¿compró?, ¿asistió?, ¿hubo incidente?) para medir la calidad de las decisiones de la IA y actualizar los ejemplos few-shot.

## Validación antes de salir en vivo
1. **Prueba con historial:** correr el clasificador sobre chats viejos y comparar su decisión con lo que realmente pasó. Da una métrica real antes de tocar un lead.
2. **Modo sombra (1–2 semanas):** la IA propone respuesta y acción; un humano aprueba con un clic.
3. **Automático gradual:** se enciende solo para casos de alta confianza y se va ampliando según las métricas.

Métricas a seguir: tasa de conversión lead → pago, tiempo de respuesta, % de leads resueltos sin humano, acuerdo IA vs. humano en modo sombra, incidentes de leads inscritos por la IA.

## Privacidad y aspectos legales (México)
- Aviso de privacidad accesible desde la conversación (LFPDPPP).
- Reglas claras sobre qué cuenta como incidente, qué se registra en `client_history` y quién tiene acceso.
- Registrar hechos, no opiniones, en los reportes de incidentes.
- Descartes siempre con un mensaje amable; nunca dejar a nadie sin respuesta.

## Stack técnico
- **Base de datos y backend:** Supabase.
  - Postgres para leads, mensajes, fichas (`jsonb`), eventos, inscripciones e historial.
  - Edge Functions para los webhooks de WhatsApp y de la pasarela de pago.
  - `pg_cron` para tareas programadas: recordatorio de ventana de 24 h, nutrición, timeouts y respuesta tras agrupar mensajes.
  - Storage para audios, imágenes y comprobantes.
  - Auth + RLS para el staff (los incidentes solo los ven admins).
  - Si las Edge Functions se quedan cortas de tiempo: cola con `pgmq` o un worker aparte (Railway), sin cambiar la base de datos.
- **Bandeja humana:** Chatwoot conectado a la API de WhatsApp.
- **Esquema:** [supabase/migrations/20261001000000_init.sql](supabase/migrations/20261001000000_init.sql).
- **Supabase CLI:** instalada como dependencia de desarrollo (`npx supabase ...`).

```
WhatsApp (Meta) ──webhook──► Supabase Edge Function
                                 │  agrupa mensajes, transcribe audios
                                 ▼
                         Llamada al LLM (respuesta + ficha JSON)
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
          Postgres (Supabase)  Chatwoot       Pasarela / Meta CAPI
          leads, mensajes,     (bandeja       (link de pago,
          fichas, historial    humana)         eventos de conversión)
                 ▲
             pg_cron: recordatorios de 24 h, nutrición, timeouts
```

## Plan por fases (MVP)
1. **Fase 1 – Responder:** webhook, Postgres (Supabase), transcripción de audios, agrupación de mensajes, base de conocimiento, bandeja compartida y paso a humano. Solo responde dudas.
2. **Fase 2 – Calificar:** ficha del lead, matriz intención × riesgo, check de `client_history`, prueba con historial y modo sombra.
3. **Fase 3 – Cobrar y optimizar ads:** link de pago, validación de comprobantes, eventos a la Conversions API de Meta.
4. **Fase 4 – Nutrir y aprender:** plantillas de nutrición y reactivación, formulario de incidentes del staff, registro de resultados para mejorar el few-shot.

## Lo que se necesita de Tovlov
- Acceso a WhatsApp Business API (Meta) y al Business Manager para la Conversions API.
- Historial real de chats para armar few-shot y la prueba con historial (ya lo tienen), idealmente con el resultado de cada lead (compró / no compró / incidente).
- Información del negocio para la base de conocimiento: precios, fechas, sedes, políticas, FAQ.
- Cuenta de pasarela de pago (Mercado Pago / Stripe).
- Definición clara de qué cuenta como "incidente" o "comportamiento problemático".
- Proceso para que el staff capture incidentes después de cada evento.
- Aviso de privacidad actualizado.
- Una o dos personas del staff para aprobar respuestas durante el modo sombra.
