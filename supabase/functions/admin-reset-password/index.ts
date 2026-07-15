import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization') || '';

    // 1) Verificar que quien llama es admin
    const asUser = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ ok: false, error: 'No autenticado' }, 401);
    const admin = createClient(url, service);
    const { data: prof } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (!prof || prof.role !== 'admin') return json({ ok: false, error: 'Solo administración puede restablecer contraseñas' }, 403);

    // 2) Localizar al usuario objetivo
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const mode = body.mode === 'password' ? 'password' : 'link';
    if (!email || !email.includes('@')) return json({ ok: false, error: 'Email no válido' }, 400);

    const { data: target } = await admin.from('profiles').select('id,role,full_name').eq('email', email).maybeSingle();
    if (!target) return json({ ok: false, error: 'No existe ningún usuario con ese email' }, 404);
    if (target.role === 'admin' && target.id !== user.id) return json({ ok: false, error: 'La contraseña de otro administrador no se toca desde aquí' }, 403);

    const audit = (action: string) =>
      admin.from('audit_logs').insert({ user_id: user.id, action, entity_type: 'auth.users', entity_id: target.id, new_data: { email, via: 'ASI' } }).then(() => {}, () => {});

    // 3a) Contraseña temporal (el admin se la comunica por un canal seguro)
    if (mode === 'password') {
      const password = String(body.password || '') || ('Nx' + crypto.randomUUID().replace(/-/g, '').slice(0, 8) + 'A1!');
      const { error: uErr } = await admin.auth.admin.updateUserById(target.id, { password });
      if (uErr) return json({ ok: false, error: uErr.message }, 400);
      await audit('reset_password_temp');
      return json({ ok: true, mode, email, password });
    }

    // 3b) Enlace de restablecimiento (no envía email: se entrega al admin para mandarlo por cualquier canal)
    const redirectTo = String(body.redirect_to || '') || 'https://client.nextstepasesor.com/reset-password';
    const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
    if (lErr) return json({ ok: false, error: lErr.message }, 400);
    await audit('reset_password_link');
    return json({ ok: true, mode, email, action_link: link.properties?.action_link });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
