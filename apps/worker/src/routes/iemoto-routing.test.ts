import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeToIemotoBot } from './webhook.js';

const friend = { id: 'friend-1', display_name: 'テスト家元客' } as never;

afterEach(() => vi.restoreAllMocks());

describe('routeToIemotoBot', () => {
  it('is disabled by default and never calls external services', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await routeToIemotoBot({}, { lineAccountId: 'rakuten', lineUserId: 'Utest', text: '家元', friend });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes only the configured LINE account and returns one reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ action: 'reply', lineText: '今日はどうした？' }), { status: 200 }));
    const env = { IEMOTO_BOT_ENABLED: 'true', IEMOTO_BOT_BASE_URL: 'http://localhost:3010', IEMOTO_LINE_ACCOUNT_ID: 'rakuten' };
    expect(await routeToIemotoBot(env, { lineAccountId: 'other', lineUserId: 'Utest', text: '家元', friend })).toBeNull();
    expect(await routeToIemotoBot(env, { lineAccountId: 'rakuten', lineUserId: 'Utest', text: '家元', friend })).toBe('今日はどうした？');
  });

  it('does not invent a response when the downstream service fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await routeToIemotoBot({ IEMOTO_BOT_ENABLED: 'true', IEMOTO_BOT_BASE_URL: 'http://localhost:3010' }, { lineAccountId: null, lineUserId: 'Utest', text: '商品相談', friend });
    expect(result).toBeNull();
  });
});
