-- =============================================================
-- Fase 1: bot que responde dudas
-- =============================================================

-- -------------------------------------------------------------
-- Storage: audios, imágenes y documentos de WhatsApp (privado)
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

-- -------------------------------------------------------------
-- Reclamar el turno de respuesta de un lead (agrupación de mensajes)
-- Cada mensaje entrante empuja `responder_a_partir_de` hacia adelante.
-- Solo responde quien llegue cuando ese momento ya pasó, y solo uno
-- (el update es atómico), así que varios mensajes seguidos generan
-- una sola respuesta.
-- -------------------------------------------------------------
create or replace function reclamar_respuesta(p_lead_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  reclamado boolean;
begin
  update leads
     set responder_a_partir_de = null
   where id = p_lead_id
     and responder_a_partir_de is not null
     and responder_a_partir_de <= now()
     and estado not in ('humano_activo', 'bloqueado')
  returning true into reclamado;

  return coalesce(reclamado, false);
end $$;

revoke execute on function reclamar_respuesta(uuid) from public, anon, authenticated;

-- -------------------------------------------------------------
-- Red de seguridad: cada minuto se llama a la Edge Function
-- `procesar-pendientes`, que responde a leads atorados (por ejemplo,
-- si falló la llamada al LLM).
--
-- Requiere dos secretos en Vault (Supabase > Project Settings > Vault,
-- o con SQL):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<mismo valor que CRON_SECRET>', 'cron_secret');
-- -------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;

select cron.schedule(
  'procesar-pendientes',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/procesar-pendientes',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
               ),
    body    := '{}'::jsonb
  );
  $$
);
