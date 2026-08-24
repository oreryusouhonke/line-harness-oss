export type CampaignCardType = 'own_coupon' | 'rakuten_campaign' | 'rakuten_coupon_check' | 'youtube' | 'other';

export interface CampaignCardConfig {
  id: string;
  type: CampaignCardType;
  title: string;
  description: string;
  buttonLabel: string;
  destinationUrl: string;
  imageUrl?: string | null;
  trackedLinkId?: string | null;
  startsAt: string;
  endsAt: string;
  priority?: number;
  audienceTagIds?: string[];
}

export interface CouponSaleAutomationConfig {
  version: 1;
  launchedAt: string;
  optimizationEnabled: boolean;
  cards: CampaignCardConfig[];
}

export interface OptimizationStage {
  key: 'initial' | 'three_day' | 'weekly' | 'personalized' | 'monthly';
  lookbackDays: number;
  personalized: boolean;
}

const SETTING_KEY = 'coupon_sale_automation';
const DAY_MS = 86_400_000;

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateCouponSaleConfig(value: unknown): CouponSaleAutomationConfig {
  if (!value || typeof value !== 'object') throw new Error('設定が空です');
  const input = value as Partial<CouponSaleAutomationConfig>;
  if (input.version !== 1) throw new Error('version は 1 を指定してください');
  if (!validDate(input.launchedAt ?? '')) throw new Error('launchedAt が不正です');
  if (typeof input.optimizationEnabled !== 'boolean') throw new Error('optimizationEnabled が不正です');
  if (!Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 10) {
    throw new Error('cards は1〜10件で指定してください');
  }

  const ids = new Set<string>();
  for (const card of input.cards) {
    if (!card.id || ids.has(card.id)) throw new Error('カードIDは必須かつ重複不可です');
    ids.add(card.id);
    if (!['own_coupon', 'rakuten_campaign', 'rakuten_coupon_check', 'youtube', 'other'].includes(card.type)) {
      throw new Error(`カード種別が不正です: ${card.id}`);
    }
    if (!card.title || !card.description || !card.buttonLabel) throw new Error(`表示文言が不足しています: ${card.id}`);
    if (!httpsUrl(card.destinationUrl)) throw new Error(`遷移先はHTTPSで指定してください: ${card.id}`);
    if (card.imageUrl && !httpsUrl(card.imageUrl)) throw new Error(`画像はHTTPSで指定してください: ${card.id}`);
    if (!validDate(card.startsAt) || !validDate(card.endsAt) || Date.parse(card.startsAt) >= Date.parse(card.endsAt)) {
      throw new Error(`開催期間が不正です: ${card.id}`);
    }
  }
  return input as CouponSaleAutomationConfig;
}

export function getOptimizationStage(launchedAt: string, now: Date): OptimizationStage {
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - Date.parse(launchedAt)) / DAY_MS));
  if (elapsedDays >= 30) return { key: 'monthly', lookbackDays: 30, personalized: true };
  if (elapsedDays >= 14) return { key: 'personalized', lookbackDays: 14, personalized: true };
  if (elapsedDays >= 7) return { key: 'weekly', lookbackDays: 7, personalized: true };
  if (elapsedDays >= 3) return { key: 'three_day', lookbackDays: 3, personalized: true };
  return { key: 'initial', lookbackDays: 0, personalized: true };
}

export function selectAndOrderCampaignCards(
  config: CouponSaleAutomationConfig,
  now: Date,
  clicks: Record<string, number> = {},
  friendTagIds: Set<string> = new Set(),
): CampaignCardConfig[] {
  const stage = getOptimizationStage(config.launchedAt, now);
  return config.cards
    .filter((card) => Date.parse(card.startsAt) <= now.getTime() && now.getTime() < Date.parse(card.endsAt))
    .map((card, index) => {
      const ownCouponPin = card.type === 'own_coupon' ? 1_000_000 : 0;
      const personalized = stage.personalized && (card.audienceTagIds ?? []).some((id) => friendTagIds.has(id)) ? 100_000 : 0;
      const priority = (card.priority ?? 0) * 1_000;
      const measured = config.optimizationEnabled && stage.lookbackDays > 0 ? (clicks[card.id] ?? 0) * 100 : 0;
      return { card, index, score: ownCouponPin + personalized + priority + measured };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ card }) => card);
}

export async function getCouponSaleConfig(db: D1Database, accountId: string): Promise<CouponSaleAutomationConfig | null> {
  const row = await db.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
  ).bind(accountId, SETTING_KEY).first<{ value: string }>();
  if (!row) return null;
  try {
    return validateCouponSaleConfig(JSON.parse(row.value));
  } catch (error) {
    console.error('[coupon-sale] invalid config', accountId, error);
    return null;
  }
}

export async function saveCouponSaleConfig(db: D1Database, accountId: string, input: unknown): Promise<CouponSaleAutomationConfig> {
  const config = validateCouponSaleConfig(input);
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  await db.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), accountId, SETTING_KEY, JSON.stringify(config), now, now).run();
  return config;
}

async function loadFriendTags(db: D1Database, friendId: string): Promise<Set<string>> {
  const rows = await db.prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = ?`).bind(friendId).all<{ tag_id: string }>();
  return new Set(rows.results.map((row) => row.tag_id));
}

async function loadRecentClicks(
  db: D1Database,
  cards: CampaignCardConfig[],
  stage: OptimizationStage,
  now: Date,
): Promise<Record<string, number>> {
  const tracked = cards.filter((card) => card.trackedLinkId);
  if (stage.lookbackDays === 0 || tracked.length === 0) return {};
  const since = new Date(now.getTime() - stage.lookbackDays * DAY_MS).toISOString();
  const ids = tracked.map((card) => card.trackedLinkId as string);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT tracked_link_id, COUNT(*) AS clicks FROM link_clicks
     WHERE tracked_link_id IN (${placeholders}) AND julianday(clicked_at) >= julianday(?) GROUP BY tracked_link_id`,
  ).bind(...ids, since).all<{ tracked_link_id: string; clicks: number }>();
  const byTrackedId = new Map(rows.results.map((row) => [row.tracked_link_id, Number(row.clicks)]));
  return Object.fromEntries(tracked.map((card) => [card.id, byTrackedId.get(card.trackedLinkId as string) ?? 0]));
}

function trackedDestination(card: CampaignCardConfig, workerUrl: string): string {
  return card.trackedLinkId
    ? `${workerUrl.replace(/\/$/, '')}/t/${encodeURIComponent(card.trackedLinkId)}`
    : card.destinationUrl;
}

function campaignBubble(card: CampaignCardConfig, workerUrl: string): Record<string, unknown> {
  const contents: Record<string, unknown> = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '18px',
      contents: [
        { type: 'text', text: card.type === 'own_coupon' ? 'LINE限定' : '開催中', size: 'xs', color: card.type === 'own_coupon' ? '#06C755' : '#b7791f', weight: 'bold' },
        { type: 'text', text: card.title, size: 'xl', weight: 'bold', wrap: true, color: '#111111' },
        { type: 'text', text: card.description, size: 'sm', wrap: true, color: '#555555' },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '16px',
      contents: [{ type: 'button', style: 'primary', color: card.type === 'own_coupon' ? '#06C755' : '#111111', action: { type: 'uri', label: card.buttonLabel, uri: trackedDestination(card, workerUrl) } }],
    },
  };
  if (card.imageUrl) {
    contents.hero = { type: 'image', url: card.imageUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
  }
  return contents;
}

export async function buildCouponSaleFlex(
  db: D1Database,
  input: { accountId: string; friendId: string; workerUrl: string; now?: Date },
): Promise<{ type: 'flex'; altText: string; contents: Record<string, unknown>; stage: OptimizationStage } | null> {
  const config = await getCouponSaleConfig(db, input.accountId);
  if (!config) return null;
  const now = input.now ?? new Date();
  const stage = getOptimizationStage(config.launchedAt, now);
  const [clicks, tags] = await Promise.all([
    loadRecentClicks(db, config.cards, stage, now),
    loadFriendTags(db, input.friendId),
  ]);
  const cards = selectAndOrderCampaignCards(config, now, clicks, tags);
  const contents = cards.length > 0
    ? { type: 'carousel', contents: cards.map((card) => campaignBubble(card, input.workerUrl)) }
    : {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
          { type: 'text', text: '現在ご案内できるクーポン・SALEはありません', weight: 'bold', wrap: true },
          { type: 'text', text: '新しい情報が始まると自動でここに表示されます。', size: 'sm', color: '#666666', wrap: true, margin: 'md' },
        ] },
      };
  return { type: 'flex', altText: '開催中のクーポン・SALE', contents, stage };
}
