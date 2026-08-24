import { describe, expect, it } from 'vitest';
import {
  getOptimizationStage,
  selectAndOrderCampaignCards,
  validateCouponSaleConfig,
  type CouponSaleAutomationConfig,
} from './coupon-sale-automation.js';

const baseConfig: CouponSaleAutomationConfig = {
  version: 1,
  launchedAt: '2026-07-20T00:00:00+09:00',
  optimizationEnabled: true,
  cards: [
    {
      id: 'own-300', type: 'own_coupon', title: '300円OFF', description: 'LINE限定',
      buttonLabel: '受け取る', destinationUrl: 'https://example.com/own', trackedLinkId: 'tl-own',
      startsAt: '2026-07-20T00:00:00+09:00', endsAt: '2026-07-27T00:00:00+09:00', priority: 10,
    },
    {
      id: 'rakuten-marathon', type: 'rakuten_campaign', title: 'お買い物マラソン', description: '開催中',
      buttonLabel: '確認する', destinationUrl: 'https://example.com/marathon', trackedLinkId: 'tl-marathon',
      startsAt: '2026-07-19T20:00:00+09:00', endsAt: '2026-07-26T01:59:00+09:00', priority: 5,
    },
    {
      id: 'youtube', type: 'youtube', title: '俺流烈歌', description: '新着',
      buttonLabel: '動画を見る', destinationUrl: 'https://youtube.com/watch?v=test',
      startsAt: '2026-07-20T00:00:00+09:00', endsAt: '2026-08-20T00:00:00+09:00', priority: 1,
      audienceTagIds: ['video-fan'],
    },
  ],
};

describe('coupon sale automation', () => {
  it('validates a usable configuration', () => {
    expect(validateCouponSaleConfig(baseConfig)).toEqual(baseConfig);
  });

  it('rejects non-HTTPS destinations', () => {
    const invalid = structuredClone(baseConfig);
    invalid.cards[0].destinationUrl = 'http://example.com';
    expect(() => validateCouponSaleConfig(invalid)).toThrow('HTTPS');
  });

  it('advances the optimization stage automatically', () => {
    expect(getOptimizationStage(baseConfig.launchedAt, new Date('2026-07-22T23:59:00+09:00')).key).toBe('initial');
    expect(getOptimizationStage(baseConfig.launchedAt, new Date('2026-07-23T00:00:00+09:00')).key).toBe('three_day');
    expect(getOptimizationStage(baseConfig.launchedAt, new Date('2026-07-27T00:00:00+09:00')).key).toBe('weekly');
    expect(getOptimizationStage(baseConfig.launchedAt, new Date('2026-08-03T00:00:00+09:00')).key).toBe('personalized');
    expect(getOptimizationStage(baseConfig.launchedAt, new Date('2026-08-19T00:00:00+09:00')).key).toBe('monthly');
    expect(getOptimizationStage(baseConfig.launchedAt, new Date('2026-07-20T00:00:00+09:00')).personalized).toBe(true);
  });

  it('removes expired cards without an operator action', () => {
    const cards = selectAndOrderCampaignCards(baseConfig, new Date('2026-07-26T02:00:00+09:00'));
    expect(cards.map((card) => card.id)).toEqual(['own-300', 'youtube']);
  });

  it('keeps the own coupon first while optimizing the remaining cards', () => {
    const cards = selectAndOrderCampaignCards(
      baseConfig,
      new Date('2026-07-24T12:00:00+09:00'),
      { 'rakuten-marathon': 100, youtube: 500 },
    );
    expect(cards[0].id).toBe('own-300');
    expect(cards.slice(1).map((card) => card.id)).toEqual(['youtube', 'rakuten-marathon']);
  });

  it('uses customer tags from the first day', () => {
    const laterConfig = structuredClone(baseConfig);
    laterConfig.cards.forEach((card) => { card.endsAt = '2026-09-30T00:00:00+09:00'; });
    const cards = selectAndOrderCampaignCards(
      laterConfig,
      new Date('2026-07-24T12:00:00+09:00'),
      {},
      new Set(['video-fan']),
    );
    expect(cards[0].id).toBe('own-300');
    expect(cards[1].id).toBe('youtube');
  });
});
