import { createClient } from "npm:@supabase/supabase-js@2.117.2";

// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente.
// La service role ignora RLS: este cliente solo se usa del lado del servidor.
export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const BUCKET_MEDIA = "whatsapp-media";
