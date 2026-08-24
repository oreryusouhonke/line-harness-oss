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

export type NextEngineRankingSyncResult = {
  fetched: number;
  eligible: number;
  products: number;
  periodStart: string;
  periodEnd: string;
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
    const detail = typeof json.message === 'string' ? ` ${json.message}` : '';
    throw new Error(`Next Engine API error: ${json.code || response.status}${detail}`);
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

type RakutenProductMedia = {
  imageUrl: string | null;
  productUrl: string | null;
};

function allowedRakutenUrl(value: unknown, kind: 'image' | 'product'): string | null {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (kind === 'product' && host !== 'item.rakuten.co.jp') return null;
    if (kind === 'image' && !host.endsWith('.rakuten.co.jp') && !host.endsWith('.r10s.jp')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function findRakutenProduct(productName: string): Promise<RakutenProductMedia> {
  const searchUrl = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(productName)}/?sid=259200`;
  const response = await fetch(searchUrl, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; OreRyuRankingBot/1.0)' },
  });
  if (!response.ok) throw new Error(`Rakuten search returned ${response.status}`);
  const html = await response.text();
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const json = JSON.parse(match[1]) as {
        '@type'?: string;
        itemListElement?: Array<{ item?: { image?: string | string[]; url?: string } }>;
      };
      if (json['@type'] !== 'ItemList') continue;
      const product = json.itemListElement?.[0]?.item;
      if (!product) continue;
      const image = Array.isArray(product.image) ? product.image[0] : product.image;
      return {
        imageUrl: allowedRakutenUrl(image, 'image'),
        productUrl: allowedRakutenUrl(product.url, 'product'),
      };
    } catch {
      // Ignore unrelated or malformed JSON-LD blocks and continue.
    }
  }
  return { imageUrl: null, productUrl: null };
}

function jstDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export async function syncNextEngineRankings(
  env: Env['Bindings'],
  now = new Date(),
): Promise<NextEngineRankingSyncResult> {
  const periodEnd = jstDate(now);
  const periodStartDate = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const periodStart = jstDate(periodStartDate);
  const fields = [
    'receive_order_row_receive_order_id',
    'receive_order_row_no',
    'receive_order_row_goods_id',
    'receive_order_row_goods_name',
    'receive_order_row_quantity',
    'receive_order_row_cancel_flag',
    'receive_order_shop_id',
    'receive_order_row_shop_cut_form_id',
    'receive_order_date',
    'receive_order_cancel_type_id',
  ].join(',');

  const allRows: Array<Record<string, unknown>> = [];
  const limit = 1000;
  for (let offset = 0; offset < 10_000; offset += limit) {
    const json = await callApi(env, '/api_v1_receiveorder_row/search', {
      fields,
      offset: String(offset),
      limit: String(limit),
      'receive_order_date-gte': `${periodStart} 00:00:00`,
      'receive_order_date-lt': `${periodEnd} 23:59:59`,
    });
    const rows = json.data || [];
    allRows.push(...rows);
    // Search responses can report the current page size in `count`.
    // Continue by offset until a short page is returned so orders after the
    // first 1,000 rows are not silently omitted.
    if (rows.length < limit) break;
  }

  const orderPrefix = env.NEXT_ENGINE_RAKUTEN_ORDER_PREFIX?.trim() || '259200-';
  const eligible = allRows.filter((row) => {
    const orderNumber = String(row.receive_order_row_shop_cut_form_id || '');
    const rowCancelled = String(row.receive_order_row_cancel_flag || '0') !== '0';
    const orderCancelled = !['', '0'].includes(String(row.receive_order_cancel_type_id || '0'));
    return orderNumber.startsWith(orderPrefix) && !rowCancelled && !orderCancelled;
  });

  const products = new Map<string, { name: string; quantity: number; orders: Set<string> }>();
  for (const row of eligible) {
    const code = String(row.receive_order_row_goods_id || '').trim();
    if (!code) continue;
    const current = products.get(code) || {
      name: String(row.receive_order_row_goods_name || code).trim() || code,
      quantity: 0,
      orders: new Set<string>(),
    };
    current.quantity += Number(row.receive_order_row_quantity || 0);
    current.orders.add(String(row.receive_order_row_receive_order_id || ''));
    products.set(code, current);
  }

  const ranked = [...products.entries()]
    .sort((a, b) => b[1].quantity - a[1].quantity || a[0].localeCompare(b[0], 'ja'))
    // LINEでの表示は上位10件のまま。商品LP制作などの社内分析では
    // 語録Tシャツだけを後段で抽出・デザイン単位へ集約できるよう、
    // 直近30日の売れた商品を十分な件数保存する。
    .slice(0, 2000);
  const productMedia = new Map<string, RakutenProductMedia>();
  for (const [code, item] of ranked.slice(0, 10)) {
    try {
      productMedia.set(code, await findRakutenProduct(item.name));
    } catch (error) {
      productMedia.set(code, { imageUrl: null, productUrl: null });
      console.error(
        `[next-engine-ranking] Rakuten media lookup failed for product ${code}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  const syncedAt = new Date().toISOString();
  const statements = [
    env.DB.prepare('DELETE FROM next_engine_product_rankings'),
    ...ranked.map(([code, item], index) => env.DB.prepare(`
      INSERT INTO next_engine_product_rankings
        (rank, product_code, product_name, image_url, product_url, quantity, order_count, period_start, period_end, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      index + 1,
      code,
      item.name,
      productMedia.get(code)?.imageUrl || null,
      productMedia.get(code)?.productUrl || null,
      item.quantity,
      item.orders.size,
      periodStart,
      periodEnd,
      syncedAt,
    )),
  ];
  await env.DB.batch(statements);

  const result = {
    fetched: allRows.length,
    eligible: eligible.length,
    products: ranked.length,
    periodStart,
    periodEnd,
  };
  await env.DB.prepare(`
    UPDATE next_engine_sync_state SET baseline_completed=1, last_synced_at=?,
      last_result_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
    WHERE id='default'
  `).bind(syncedAt, JSON.stringify(result)).run();
  return result;
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
    const sync = await syncNextEngineRankings(c.env);
    return c.text(
      `LINE Harness and Next Engine are connected. Ranking sync completed (${sync.products} products). You can close this window.`,
    );
  } catch (error) {
    console.error(
      'Next Engine authorization or ranking sync failed:',
      error instanceof Error ? error.message : error,
    );
    return c.text('Next Engine authorization failed. Check the LINE Harness logs.', 502);
  }
});

nextEngine.post('/api/next-engine/sync', async (c) => {
  try {
    const result = await syncNextEngineRankings(c.env);
    return c.json({ success: true, ...result });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Next Engine sync failed' }, 502);
  }
});

export { nextEngine };
