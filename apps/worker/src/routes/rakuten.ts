import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index.js';

const RAKUTEN_API_BASE = 'https://api.rms.rakuten.co.jp/es';
const rakuten = new Hono<Env>();

type RakutenCredentials = {
  serviceSecret: string;
  licenseKey: string;
};

type RakutenApiError = {
  status: number;
  message: string;
};

const RAKUTEN_ENV_KEYS = ['RAKUTEN_SERVICE_SECRET', 'RAKUTEN_LICENSE_KEY'] as const;

function getCredentials(env: Env['Bindings']): RakutenCredentials | null {
  const serviceSecret = env.RAKUTEN_SERVICE_SECRET?.trim();
  const licenseKey = env.RAKUTEN_LICENSE_KEY?.trim();
  if (!serviceSecret || !licenseKey) return null;
  return { serviceSecret, licenseKey };
}

function missingRakutenEnv(env: Env['Bindings']): string[] {
  return RAKUTEN_ENV_KEYS.filter((key) => !env[key]?.trim());
}

function isAuthorized(c: Context<Env>): boolean {
  const authHeader = c.req.header('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length);
  return Boolean(token && (token === c.env.API_KEY || token === c.env.LEGACY_API_KEY));
}

export function buildRakutenAuthorizationHeader(credentials: RakutenCredentials): string {
  return `ESA ${btoa(`${credentials.serviceSecret}:${credentials.licenseKey}`)}`;
}

function rakutenHeaders(credentials: RakutenCredentials): HeadersInit {
  return {
    Authorization: buildRakutenAuthorizationHeader(credentials),
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readRakutenResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function extractErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return 'Rakuten API request failed';
  const record = body as Record<string, unknown>;
  const message =
    safeString(record.message) ||
    safeString(record.error) ||
    safeString(record.errorMessage) ||
    safeString(record.msg);
  if (message) return message;

  const messages = record.MessageModelList;
  if (Array.isArray(messages)) {
    const joined = messages
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const msg = safeString((item as Record<string, unknown>).message);
        const code = safeString((item as Record<string, unknown>).messageCode);
        return [code, msg].filter(Boolean).join(': ');
      })
      .filter(Boolean)
      .join(', ');
    if (joined) return joined;
  }

  return 'Rakuten API request failed';
}

async function fetchRakutenJson(
  url: string,
  credentials: RakutenCredentials,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...rakutenHeaders(credentials),
      ...(init.headers || {}),
    },
  });
  const body = await readRakutenResponse(res);
  if (!res.ok) {
    throw {
      status: res.status,
      message: extractErrorMessage(body),
    } satisfies RakutenApiError;
  }
  return { status: res.status, body };
}

function handleRakutenError(c: Context<Env>, err: unknown) {
  const apiError = err as Partial<RakutenApiError>;
  if (typeof apiError.status === 'number') {
    return c.json({ success: false, status: apiError.status, error: apiError.message || 'Rakuten API request failed' }, apiError.status as 400);
  }
  return c.json({ success: false, status: 500, error: 'Rakuten API request failed' }, 500);
}

function firstValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function firstImageUrl(item: Record<string, unknown>): string | null {
  const images = item.images;
  if (Array.isArray(images)) {
    for (const image of images) {
      if (image && typeof image === 'object') {
        const location = safeString((image as Record<string, unknown>).location);
        if (location) return location;
      }
    }
  }
  return null;
}

function firstPrice(item: Record<string, unknown>): string | number | null {
  const variants = item.variants;
  if (!variants || typeof variants !== 'object') return null;
  for (const variant of Object.values(variants as Record<string, unknown>)) {
    if (variant && typeof variant === 'object') {
      const price = firstValue((variant as Record<string, unknown>).standardPrice);
      if (price !== null) return price as string | number;
    }
  }
  return null;
}

function summarizeItem(body: unknown) {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const results = Array.isArray(record.results) ? record.results : [];
  const first = results[0] && typeof results[0] === 'object' ? (results[0] as Record<string, unknown>) : null;
  const item = first?.item && typeof first.item === 'object' ? (first.item as Record<string, unknown>) : null;
  if (!item) return null;

  return {
    itemName: firstValue(item.title),
    manageNumber: firstValue(item.manageNumber),
    price: firstPrice(item),
    imageUrl: firstImageUrl(item),
  };
}

const PII_KEY_PATTERN = /(name|kana|mail|email|phone|tel|zip|postal|address|prefecture|city|street|family|first|last|birth|sender|orderer|delivery|buyer|recipient)/i;

function maskPii(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (PII_KEY_PATTERN.test(key)) return '[MASKED]';

  if (typeof value === 'string') {
    if (value.includes('@')) return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[MASKED_EMAIL]');
    if (/[0-9]{2,4}[-\s]?[0-9]{2,4}[-\s]?[0-9]{3,4}/.test(value)) return '[MASKED_PHONE]';
    return value;
  }

  if (Array.isArray(value)) return value.map((item) => maskPii(item));
  if (typeof value === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      masked[childKey] = maskPii(childValue, childKey);
    }
    return masked;
  }
  return value;
}

function findOrderNumber(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const orderNumberList = record.orderNumberList;
  if (Array.isArray(orderNumberList) && typeof orderNumberList[0] === 'string') return orderNumberList[0];
  return null;
}

rakuten.use('/rakuten/*', async (c, next) => {
  if (!isAuthorized(c)) return c.json({ success: false, error: 'Unauthorized' }, 401);
  return next();
});

rakuten.get('/rakuten/health', (c) => {
  const credentials = getCredentials(c.env);
  const missing = missingRakutenEnv(c.env);
  let authorizationHeaderGenerated = false;
  if (credentials) {
    authorizationHeaderGenerated = buildRakutenAuthorizationHeader(credentials).startsWith('ESA ');
  }
  if (missing.length > 0) {
    return c.json({
      ok: false,
      rakutenConfigured: false,
      missing,
    });
  }
  return c.json({
    ok: authorizationHeaderGenerated,
    rakutenConfigured: true,
  });
});

rakuten.get('/rakuten/items/test', async (c) => {
  const credentials = getCredentials(c.env);
  if (!credentials) return c.json({ success: false, error: 'Rakuten credentials are not configured' }, 500);

  try {
    const url = new URL(`${RAKUTEN_API_BASE}/2.0/items/search`);
    url.searchParams.set('hits', '1');
    url.searchParams.set('offset', '0');
    url.searchParams.set('sortKey', 'updated');
    url.searchParams.set('sortOrder', 'desc');
    const { body } = await fetchRakutenJson(url.toString(), credentials, { method: 'GET' });
    const item = summarizeItem(body);
    if (!item) return c.json({ success: false, status: 404, error: 'No item found' }, 404);
    return c.json({ success: true, data: item });
  } catch (err) {
    return handleRakutenError(c, err);
  }
});

rakuten.get('/rakuten/orders/test', async (c) => {
  const credentials = getCredentials(c.env);
  if (!credentials) return c.json({ success: false, error: 'Rakuten credentials are not configured' }, 500);

  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const formatJst = (date: Date) => {
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return `${jst.toISOString().slice(0, 19)}+0900`;
  };

  try {
    const searchBody = {
      dateType: 1,
      startDatetime: formatJst(start),
      endDatetime: formatJst(end),
      orderProgressList: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      PaginationRequestModel: {
        requestRecordsAmount: 1,
        requestPage: 1,
        SortModelList: [{ sortColumn: 1, sortDirection: 2 }],
      },
    };
    const search = await fetchRakutenJson(`${RAKUTEN_API_BASE}/2.0/order/searchOrder/`, credentials, {
      method: 'POST',
      body: JSON.stringify(searchBody),
    });
    const orderNumber = findOrderNumber(search.body);
    if (!orderNumber) return c.json({ success: false, status: 404, error: 'No order found' }, 404);

    const detail = await fetchRakutenJson(`${RAKUTEN_API_BASE}/2.0/order/getOrder/`, credentials, {
      method: 'POST',
      body: JSON.stringify({ orderNumberList: [orderNumber], version: '7' }),
    });

    return c.json({
      success: true,
      data: maskPii(detail.body),
    });
  } catch (err) {
    return handleRakutenError(c, err);
  }
});

export { rakuten };
