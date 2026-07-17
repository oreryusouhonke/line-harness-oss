import { Hono } from 'hono';
import type { Env } from '../index.js';

const API_BASE = 'https://api.next-engine.org';
const SIGN_IN_URL = 'https://base.next-engine.org/users/sign_in/';
const nextEngine = new Hono<Env>();

type TokenRow = {
  access_token: string;
  refresh_token: string;
};

type NeResponse = {
  result?: string;
  code?: string;
  message?: unknown;
  access_token?: string;
  refresh_token?: string;
  access_token_end_date?: string;
  refresh_token_end_date?: string;
  company_ne_id?: string;
  company_name?: string;
  data?: Array<Record<string, unknown>>;
  count?: string | number;
};

function config(env: Env['Bindings']) {
  const clientId = env.NEXT_ENGINE_CLIENT_ID?.trim();
  const clientSecret = env.NEXT_ENGINE_CLIENT_SECRET?.trim();
  const redirectUri = env.NEXT_ENGINE_REDIRECT_URI?.trim();
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
}

async function postForm(url: string, body: Record<string, string>): Promise<NeResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await response.json<NeResponse>();
  if (!response.ok || json.result !== 'success') {
    throw new Error(`Next Engine API error: ${json.code || response.status}`);
  }
  return json;
}

async function saveTokens(db: D1Database, json: NeResponse) {
  if (!json.access_token || !json.refresh_token) return;
  await db.prepare(`
    INSERT INTO next_engine_credentials
      (id, company_ne_id, company_name, access_token, refresh_token, access_token_end, refresh_token_end, updated_at)
    VALUES ('default', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
    ON CONFLICT(id) DO UPDATE SET
      company_ne_id=COALESCE(excluded.company_ne_id, company_ne_id),
      company_name=COALESCE(excluded.company_name, company_name),
      access_token=excluded.access_token, refresh_token=excluded.refresh_token,
      access_token_end=excluded.access_token_end, refresh_token_end=excluded.refresh_token_end,
      updated_at=excluded.updated_at
  `).bind(
    json.company_ne_id || null, json.company_name || null,
    json.access_token, json.refresh_token,
    json.access_token_end_date || null, json.refresh_token_end_date || null,
  ).run();
}

async function credentials(db: D1Database): Promise<TokenRow | null> {
  return db.prepare('SELECT access_token, refresh_token FROM next_engine_credentials WHERE id = ?')
    .bind('default').first<TokenRow>();
}

async function callApi(env: Env['Bindings'], endpoint: string, extra: Record<string, string>) {
  const tokens = await credentials(env.DB);
  if (!tokens) throw new Error('Next Engine is not authorized');
  const json = await postForm(`${API_BASE}${endpoint}`, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    wait_flag: '1',
    ...extra,
  });
  await saveTokens(env.DB, json);
  return json;
}

nextEngine.get('/api/next-engine/health', async (c) => {
  const configured = Boolean(config(c.env));
  const tokens = await credentials(c.env.DB);
  return c.json({ ok: configured && Boolean(tokens), configured, authorized: Boolean(tokens), mode: 'read-only' });
});

nextEngine.get('/api/next-engine/auth/start', (c) => {
  const cfg = config(c.env);
  if (!cfg) return c.json({ success: false, error: 'Next Engine client settings are missing' }, 503);
  const url = new URL(SIGN_IN_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  return c.redirect(url.toString());
});

// Public OAuth callback; authMiddleware explicitly allows /auth/*.
nextEngine.get('/auth/next-engine/callback', async (c) => {
  const cfg = config(c.env);
  const uid = c.req.query('uid');
  const state = c.req.query('state');
  if (!cfg || !uid || !state) return c.text('Next Engine authorization parameters are missing.', 400);
  try {
    const json = await postForm(`${API_BASE}/api_neauth`, {
      uid, state, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    });
    await saveTokens(c.env.DB, json);
    return c.text('LINE Harness and Next Engine are connected. You can close this window.');
  } catch {
    return c.text('Next Engine authorization failed. Check the LINE Harness logs.', 502);
  }
});

nextEngine.post('/api/next-engine/sync', async (c) => {
  const fields = [
    'receive_order_id', 'receive_order_shop_id', 'receive_order_shop_cut_form_id',
    'receive_order_order_status', 'receive_order_date', 'receive_order_last_modified_date',
  ].join(',');
  try {
    const json = await callApi(c.env, '/api_v1_receiveorder_base/search', {
      fields, offset: '0', limit: '100',
    });
    const rows = json.data || [];
    const state = await c.env.DB.prepare('SELECT baseline_completed FROM next_engine_sync_state WHERE id = ?')
      .bind('default').first<{ baseline_completed: number }>();
    const baseline = !state?.baseline_completed;
    const statements = rows.map((row) => c.env.DB.prepare(`
      INSERT INTO next_engine_orders
        (receive_order_id, shop_id, shop_cut_form_id, order_status, order_date, last_modified_date, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receive_order_id) DO UPDATE SET
        shop_id=excluded.shop_id, shop_cut_form_id=excluded.shop_cut_form_id,
        order_status=excluded.order_status, order_date=excluded.order_date,
        last_modified_date=excluded.last_modified_date, raw_json=excluded.raw_json,
        last_seen_at=strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
    `).bind(
      String(row.receive_order_id || ''), row.receive_order_shop_id || null,
      row.receive_order_shop_cut_form_id || null, row.receive_order_order_status || null,
      row.receive_order_date || null, row.receive_order_last_modified_date || null,
      JSON.stringify(row),
    ));
    if (statements.length) await c.env.DB.batch(statements);
    const result = { baseline, fetched: rows.length, notificationsGenerated: 0 };
    await c.env.DB.prepare(`
      UPDATE next_engine_sync_state SET baseline_completed=1,
        last_synced_at=strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
        last_result_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id='default'
    `).bind(JSON.stringify(result)).run();
    return c.json({ success: true, ...result });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Next Engine sync failed' }, 502);
  }
});

export { nextEngine };
