import { describe, expect, it } from 'vitest';
import { isDesignBotStartTrigger, isSharedDesignAccountChannel, isSharedDesignSessionActive } from './webhook.js';

const trigger = 'AIでデザイン作成をします。※返信に少し時間が掛かる場合があります。';

function event(text: string) {
  return { type: 'message', message: { type: 'text', text } } as never;
}

function dbWithLatest(content: string | null) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: content === null ? [] : [{ content }] }),
      }),
    }),
  } as unknown as D1Database;
}

describe('shared design Bot session gate', () => {
  it('allows the design Bot account itself and every shared design entry account', () => {
    expect(isSharedDesignAccountChannel('2004093583')).toBe(true);
    expect(isSharedDesignAccountChannel('2010637219')).toBe(true);
    expect(isSharedDesignAccountChannel('2010637235')).toBe(true);
    expect(isSharedDesignAccountChannel('not-allowed')).toBe(false);
  });

  it('accepts harmless rich-menu trigger formatting differences', async () => {
    expect(await isSharedDesignSessionActive(dbWithLatest(null), 'friend-1', event(trigger))).toBe(true);
    expect(isDesignBotStartTrigger(' AIでデザイン作成をします。\n※ 返信に少し時間がかかる場合があります。 ')).toBe(true);
    expect(await isSharedDesignSessionActive(dbWithLatest(null), 'friend-1', event('デザインを作成'))).toBe(false);
    expect(await isSharedDesignSessionActive(dbWithLatest(null), 'friend-1', event('普通のスタッフへの質問です'))).toBe(false);
  });

  it('continues only when a recent design session exists', async () => {
    expect(await isSharedDesignSessionActive(dbWithLatest(trigger), 'friend-1', event('青にして'))).toBe(true);
    expect(await isSharedDesignSessionActive(dbWithLatest('AIでデザイン作成をします。 ※返信に少し時間がかかる場合があります。'), 'friend-1', event('青にして'))).toBe(true);
    expect(await isSharedDesignSessionActive(dbWithLatest(null), 'friend-1', event('青にして'))).toBe(false);
  });

  it('stops immediately on an end message', async () => {
    expect(await isSharedDesignSessionActive(dbWithLatest(trigger), 'friend-1', event('終了'))).toBe(false);
    expect(await isSharedDesignSessionActive(dbWithLatest('終了'), 'friend-1', event('続きをお願いします'))).toBe(false);
  });
});
