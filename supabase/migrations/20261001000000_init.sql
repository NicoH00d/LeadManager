-- =============================================================
-- LeadSight / Tovlov — esquema inicial
-- Pegar en Supabase > SQL Editor, o aplicar con `supabase db push`.
-- =============================================================

create extension if not exists pgcrypto;

-- -------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------
create type lead_estado as enum (
  'en_progreso',     -- la IA sigue conversando
  'humano_activo',   -- staff tomó la conversación; bot pausado
  'esperando_pago',  -- se mandó link de pago
  'inscrito',        -- pago confirmado
  'sin_respuesta',   -- el lead dejó de contestar
  'resuelto',        -- acción final asignada
  'bloqueado'        -- no se le responde automáticamente
);

create type lead_accion as enum (
  'inscribir_directo',
  'llamada_humana',
  'nutrir',
  'descartar',
  'no_califica',
  'lista_espera'
);

create type msg_direccion as enum ('entrante', 'saliente');
create type msg_autor     as enum ('lead', 'bot', 'humano', 'sistema');
create type msg_tipo      as enum ('texto', 'audio', 'imagen', 'documento', 'plantilla', 'otro');

-- borrador/rechazado se usan en modo sombra (un humano aprueba antes de enviar)
create type msg_envio as enum ('borrador', 'aprobado', 'rechazado', 'enviado', 'entregado', 'leido', 'fallido');

create type pago_estado      as enum ('pendiente', 'pagado', 'en_revision', 'cancelado', 'reembolsado');
create type historial_tipo   as enum ('asistencia', 'incidente', 'flag', 'nota');
create type severidad        as enum ('baja', 'media', 'alta');
create type tarea_tipo       as enum ('recordatorio_ventana', 'nutricion', 'timeout_sin_respuesta', 'otro');
create type tarea_estado     as enum ('pendiente', 'ejecutada', 'cancelada', 'fallida');
create type staff_rol        as enum ('admin', 'staff');

-- -------------------------------------------------------------
-- Utilidad: updated_at automático
-- -------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- -------------------------------------------------------------
-- Staff (vinculado a auth.users de Supabase)
-- -------------------------------------------------------------
create table staff_profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null,
  rol        staff_rol not null default 'staff',
  created_at timestamptz not null default now()
);

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_profiles where user_id = auth.uid());
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_profiles where user_id = auth.uid() and rol = 'admin');
$$;

-- -------------------------------------------------------------
-- Eventos
-- -------------------------------------------------------------
create table eventos (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  fecha      timestamptz not null,
  ciudad     text not null,
  sede       text,
  precio_mxn numeric(10,2) not null,
  cupo       int,
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_eventos_updated before update on eventos
  for each row execute function set_updated_at();

-- -------------------------------------------------------------
-- Leads
-- -------------------------------------------------------------
create table leads (
  id                     uuid primary key default gen_random_uuid(),
  telefono               text not null unique
                           check (telefono ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164
  nombre                 text,
  estado                 lead_estado not null default 'en_progreso',
  accion                 lead_accion,
  accion_razon           text,

  -- Última ficha (copia de la evaluación más reciente) + columnas para filtrar rápido
  ficha                  jsonb not null default '{}'::jsonb,
  intencion              numeric(3,2) check (intencion between 0 and 1),
  riesgo                 numeric(3,2) check (riesgo between 0 and 1),
  confianza              numeric(3,2) check (confianza between 0 and 1),
  evento_interes_id      uuid references eventos(id),

  -- Atribución de anuncios Click-to-WhatsApp (para Conversions API)
  ctwa_clid              text,
  referral               jsonb,

  -- Ventana de 24 h de Meta y agrupación de mensajes
  ultimo_mensaje_lead_at timestamptz,
  responder_a_partir_de  timestamptz,  -- debounce: el worker responde cuando now() >= este valor

  asignado_a             uuid references staff_profiles(user_id),
  chatwoot_conversation_id bigint,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index idx_leads_estado on leads(estado);
create index idx_leads_accion on leads(accion);
create index idx_leads_responder on leads(responder_a_partir_de)
  where responder_a_partir_de is not null;
create trigger trg_leads_updated before update on leads
  for each row execute function set_updated_at();

-- -------------------------------------------------------------
-- Mensajes
-- -------------------------------------------------------------
create table mensajes (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references leads(id) on delete cascade,
  direccion      msg_direccion not null,
  autor          msg_autor not null,
  tipo           msg_tipo not null default 'texto',
  contenido      text,             -- texto, o descripción/caption
  transcripcion  text,             -- audios
  media_url      text,             -- ruta en Supabase Storage
  plantilla      text,             -- nombre de plantilla de Meta, si aplica
  wa_message_id  text unique,      -- idempotencia: Meta reintenta webhooks
  estado_envio   msg_envio,        -- solo salientes
  aprobado_por   uuid references staff_profiles(user_id),
  procesado      boolean not null default false,  -- entrante ya considerado por la IA
  created_at     timestamptz not null default now()
);
create index idx_mensajes_lead on mensajes(lead_id, created_at);
create index idx_mensajes_borradores on mensajes(estado_envio) where estado_envio = 'borrador';

-- -------------------------------------------------------------
-- Evaluaciones (ficha por turno; auditoría y métricas)
-- -------------------------------------------------------------
create table evaluaciones (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  mensaje_id       uuid references mensajes(id) on delete set null,  -- respuesta generada en ese turno
  ficha            jsonb not null,
  intencion        numeric(3,2),
  riesgo           numeric(3,2),
  confianza        numeric(3,2),
  accion_sugerida  lead_accion,
  razon            text,
  modelo           text,
  -- Modo sombra: lo que decidió el humano, para medir acuerdo IA vs humano
  accion_humana    lead_accion,
  created_at       timestamptz not null default now()
);
create index idx_evaluaciones_lead on evaluaciones(lead_id, created_at);

-- -------------------------------------------------------------
-- Historial de clientes (asistencias, incidentes, flags)
-- Se liga por teléfono porque el incidente puede existir antes que el lead.
-- -------------------------------------------------------------
create table client_history (
  id           uuid primary key default gen_random_uuid(),
  telefono     text not null check (telefono ~ '^\+[1-9][0-9]{7,14}$'),
  lead_id      uuid references leads(id) on delete set null,
  evento_id    uuid references eventos(id) on delete set null,
  tipo         historial_tipo not null,
  severidad    severidad,
  descripcion  text not null,      -- hechos, no opiniones
  activo       boolean not null default true,
  reportado_por uuid references staff_profiles(user_id),
  created_at   timestamptz not null default now()
);
create index idx_history_telefono on client_history(telefono);

-- Flags vigentes que hacen saltar la conversación exploratoria
create view v_flags_activos as
select telefono,
       max(severidad) as severidad_max,
       count(*)       as total,
       max(created_at) as ultimo
from client_history
where activo and tipo in ('incidente', 'flag') and severidad in ('media', 'alta')
group by telefono;

-- -------------------------------------------------------------
-- Inscripciones y pagos
-- -------------------------------------------------------------
create table inscripciones (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid not null references leads(id) on delete cascade,
  evento_id           uuid not null references eventos(id),
  estado              pago_estado not null default 'pendiente',
  monto_mxn           numeric(10,2) not null,
  proveedor           text,          -- mercadopago | stripe | oxxo | transferencia
  link_pago           text,
  proveedor_pago_id   text unique,   -- id del pago en la pasarela (idempotencia de webhooks)
  comprobante_url     text,          -- foto del comprobante en Storage
  pagado_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (lead_id, evento_id)
);
create trigger trg_inscripciones_updated before update on inscripciones
  for each row execute function set_updated_at();

-- -------------------------------------------------------------
-- Base de conocimiento (editable por el staff)
-- -------------------------------------------------------------
create table knowledge_base (
  id         uuid primary key default gen_random_uuid(),
  categoria  text not null,        -- precios | fechas | sedes | politicas | faq
  titulo     text not null,
  contenido  text not null,
  activo     boolean not null default true,
  updated_by uuid references staff_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_kb_updated before update on knowledge_base
  for each row execute function set_updated_at();

-- -------------------------------------------------------------
-- Tareas programadas (recordatorio de 24 h, nutrición, timeouts)
-- Las ejecuta un worker disparado por pg_cron.
-- -------------------------------------------------------------
create table tareas_programadas (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  tipo        tarea_tipo not null,
  ejecutar_at timestamptz not null,
  estado      tarea_estado not null default 'pendiente',
  plantilla   text,
  payload     jsonb not null default '{}'::jsonb,
  intentos    int not null default 0,
  error       text,
  created_at  timestamptz not null default now()
);
create index idx_tareas_pendientes on tareas_programadas(ejecutar_at) where estado = 'pendiente';

-- -------------------------------------------------------------
-- Eventos enviados a Meta Conversions API
-- -------------------------------------------------------------
create table meta_capi_eventos (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  event_name  text not null,       -- ej. LeadCalificado, Purchase
  event_id    text not null unique,-- deduplicación en Meta
  payload     jsonb not null,
  enviado     boolean not null default false,
  respuesta   jsonb,
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- Vista: estado de la ventana de 24 h por lead
-- -------------------------------------------------------------
create view v_ventana_24h as
select id as lead_id,
       telefono,
       estado,
       ultimo_mensaje_lead_at,
       ultimo_mensaje_lead_at + interval '24 hours' as ventana_cierra_at,
       (ultimo_mensaje_lead_at + interval '24 hours') > now() as ventana_abierta
from leads
where ultimo_mensaje_lead_at is not null;

-- =============================================================
-- Row Level Security
-- Las Edge Functions usan la service_role key, que ignora RLS.
-- Estas políticas aplican al staff que entra con Supabase Auth.
-- =============================================================
alter table staff_profiles     enable row level security;
alter table eventos            enable row level security;
alter table leads              enable row level security;
alter table mensajes           enable row level security;
alter table evaluaciones       enable row level security;
alter table client_history     enable row level security;
alter table inscripciones      enable row level security;
alter table knowledge_base     enable row level security;
alter table tareas_programadas enable row level security;
alter table meta_capi_eventos  enable row level security;

-- Staff: lectura general
create policy staff_read on eventos        for select using (is_staff());
create policy staff_read on leads          for select using (is_staff());
create policy staff_read on mensajes       for select using (is_staff());
create policy staff_read on evaluaciones   for select using (is_staff());
create policy staff_read on inscripciones  for select using (is_staff());
create policy staff_read on knowledge_base for select using (is_staff());
create policy self_read  on staff_profiles for select using (user_id = auth.uid() or is_admin());

-- Staff: operación diaria
create policy staff_update on leads          for update using (is_staff());
create policy staff_update on mensajes       for update using (is_staff());     -- aprobar borradores
create policy staff_update on evaluaciones   for update using (is_staff());     -- registrar accion_humana
create policy staff_write  on knowledge_base for all    using (is_staff()) with check (is_staff());

-- Incidentes: el staff puede reportar; solo admin puede leer/editar (privacidad)
create policy staff_insert on client_history for insert with check (is_staff());
create policy admin_all    on client_history for all    using (is_admin()) with check (is_admin());

-- Admin: todo lo demás
create policy admin_all on eventos            for all using (is_admin()) with check (is_admin());
create policy admin_all on inscripciones      for all using (is_admin()) with check (is_admin());
create policy admin_all on staff_profiles     for all using (is_admin()) with check (is_admin());
create policy admin_all on tareas_programadas for all using (is_admin()) with check (is_admin());
create policy admin_all on meta_capi_eventos  for all using (is_admin()) with check (is_admin());

-- Las vistas respetan RLS de las tablas base
alter view v_flags_activos set (security_invoker = on);
alter view v_ventana_24h  set (security_invoker = on);
