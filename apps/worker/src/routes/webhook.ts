import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
  getEntryRouteByRefCode,
  getMessageTemplateById,
  addTagToFriend,
} from '@line-crm/db';
import type { EntryRoute, Friend } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { matchAndReply } from '../services/auto-reply.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { pushImmediateFirstStep } from '../services/immediate-first-step.js';
import { buildCouponSaleFlex } from '../services/coupon-sale-automation.js';
import { handoffConversation } from '../services/conversation-control-store.js';
import { dispatchConversationOutbound } from '../services/conversation-outbound.js';
import {
  claimRetryableWebhookEvents,
  completeWebhookEvent,
  failWebhookEvent,
  reserveWebhookEvent,
} from '../services/line-webhook-dedup.js';
import { redactSensitiveText } from '../services/sensitive-data.js';
import { recordAiFailure, recordAiSuccess } from '../services/ai-service-health.js';
import type { Env } from '../index.js';
import { awardActivityMileage } from '../services/activity-mileage.js';
import { replyViaHarnessProxy } from '../services/line-proxy-send.js';
import type { HarnessProxyDispatch } from '../services/line-proxy-send.js';
import { dispatchLineProxyLocally } from '../services/local-line-proxy.js';

const webhook = new Hono<Env>();
const INFLOW_SOURCE_TAG_BY_MESSAGE: Record<string, string> = {
  '楽天市場から来ました。': '流入元：楽天',
  '公式オンラインショップから来ました。': '流入元：自社',
  'SNS・広告から来ました。': '流入元：広告',
  'その他から来ました。': '流入元：その他',
};

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB
const RAKUTEN_SHOP_ID = '259200';

type MirroredDesignMessage = {
  type: 'text' | 'image' | 'template' | 'flex';
  text?: string;
  originalContentUrl?: string;
  previewImageUrl?: string;
  altText?: string;
  contents?: unknown;
  template?: unknown;
};

async function signForSecret(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

function mirroredMessageContent(message: MirroredDesignMessage): { messageType: string; content: string } {
  if (message.type === 'text') return { messageType: 'text', content: String(message.text ?? '') };
  if (message.type === 'image') {
    return {
      messageType: 'image',
      content: JSON.stringify({
        originalContentUrl: message.originalContentUrl ?? null,
        previewImageUrl: message.previewImageUrl ?? null,
      }),
    };
  }
  return {
    messageType: 'flex',
    content: JSON.stringify({
      type: message.type,
      altText: message.altText ?? null,
      contents: message.contents ?? null,
      template: message.template ?? null,
    }),
  };
}

type RankingRow = {
  rank: number;
  product_code: string;
  product_name: string;
  image_url: string | null;
  product_url: string | null;
  period_start: string;
  period_end: string;
};

function compactProductName(name: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim();
  return normalized.length > 88 ? `${normalized.slice(0, 87)}…` : normalized;
}

export function buildRankingFlex(rows: RankingRow[]): Record<string, unknown> {
  const productDestination = (item: RankingRow) => item.product_url
    || `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(item.product_name)}/?sid=${RAKUTEN_SHOP_ID}`;
  return {
    type: 'carousel',
    contents: rows.map((item) => ({
      type: 'bubble',
      size: 'kilo',
      ...(item.image_url ? {
        hero: {
          type: 'image',
          url: item.image_url,
          size: 'full',
          aspectRatio: '1:1',
          aspectMode: 'cover',
          action: {
            type: 'uri',
            uri: productDestination(item),
          },
        },
      } : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          {
            type: 'text',
            text: `${item.rank}位`,
            size: item.rank <= 3 ? 'xl' : 'lg',
            weight: 'bold',
            color: item.rank === 1 ? '#c69214' : '#111111',
          },
          {
            type: 'text',
            text: compactProductName(item.product_name),
            size: 'md',
            weight: 'bold',
            wrap: true,
            color: '#111111',
          },
          {
            type: 'text',
            text: '直近30日間の人気商品',
            size: 'xs',
            color: '#777777',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [{
          type: 'button',
          style: 'primary',
          color: '#111111',
          action: {
            type: 'uri',
            label: '商品を見る',
            uri: productDestination(item),
          },
        }],
      },
    })),
  };
}

async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  let friend = await getFriendByLineUserId(db, userId, lineAccountId);

  if (!friend) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      // A signed webhook already proves this user interacted with the bot.
      // If profile lookup is temporarily unavailable, keep the event processable
      // by creating the friend with the LINE userId and filling profile later.
      console.error('[webhook] Failed to get profile for unknown user', userId, err);
    }

    friend = await upsertFriend(db, {
      lineUserId: userId,
      lineAccountId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });
    console.log(`[webhook] auto-registered existing friend userId=${userId} friendId=${friend.id}`);
  }

  return friend;
}

async function findTagIdByName(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM tags WHERE name = ? LIMIT 1').bind(name).first<{ id: string }>();
  return row?.id ?? null;
}

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  // Verify signature BEFORE JSON.parse so attacker-controlled bodies never reach the parser.
  // Fast path: try env default secret first so malformed/unauthenticated traffic
  //   fails fast without a D1 lookup. The main account is typically also registered
  //   in line_accounts; on env match we still look it up so matchedAccountId binds
  //   correctly for downstream account-scoped filters.
  // Slow path: iterate DB-registered accounts for genuinely multi-account installs.
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;
  let valid = false;

  const envSecret = c.env.LINE_CHANNEL_SECRET;
  if (envSecret) {
    valid = await verifySignature(envSecret, rawBody, signature);
    if (valid) {
      const accounts = await getLineAccounts(db);
      const main = accounts.find(
        (a) => a.is_active && a.channel_secret === envSecret,
      );
      if (main) {
        channelAccessToken = main.channel_access_token;
        matchedAccountId = main.id;
      }
    }
  }

  if (!valid) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if (envSecret && account.channel_secret === envSecret) continue; // already tried via fast path
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        valid = true;
        break;
      }
    }
  }

  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // Persist every event before acknowledging LINE. If D1 is unavailable, a
  // non-2xx response asks LINE to redeliver instead of silently losing the body.
  const reservedEvents: WebhookEvent[] = [];
  for (const event of body.events) {
    try {
      if (await reserveWebhookEvent(db, event, matchedAccountId)) reservedEvents.push(event);
    } catch (error) {
      console.error('[webhook] failed to persist event before acknowledgement', error);
      return c.json({ status: 'retry_later' }, 503);
    }
  }

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    const proxyDispatch: HarnessProxyDispatch = (request) =>
      dispatchLineProxyLocally(request, c.env, c.executionCtx);
    for (const event of reservedEvents) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env.LIFF_URL, c.env.IMAGES, proxyDispatch, c.env);
        try { await completeWebhookEvent(db, event.webhookEventId); } catch { /* non-fatal audit update */ }
      } catch (err) {
        console.error('Error handling webhook event:', err);
        try { await failWebhookEvent(db, event.webhookEventId, err instanceof Error ? err.message : 'unknown'); } catch { /* non-fatal */ }
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

webhook.post('/internal/design-bot/outgoing', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-design-signature') ?? '';
  if (!signature) return c.json({ ok: false }, 401);

  const accounts = await getLineAccounts(c.env.DB);
  let signingAccount = accounts.find((account) =>
    account.is_active && account.channel_id === DESIGN_BOT_CHANNEL_ID);
  if (!signingAccount) {
    signingAccount = accounts.find((account) => account.is_active && account.channel_secret === c.env.LINE_CHANNEL_SECRET);
  }
  if (!signingAccount) return c.json({ ok: false }, 404);

  const expected = await signForSecret(signingAccount.channel_secret, rawBody);
  if (expected !== signature) return c.json({ ok: false }, 401);

  let payload: {
    accountId?: string;
    lineUserId?: string;
    messages?: MirroredDesignMessage[];
    deliveryType?: 'reply' | 'push';
    source?: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false }, 400);
  }

  const lineUserId = String(payload.lineUserId || '');
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!lineUserId || messages.length === 0) return c.json({ ok: false }, 400);
  const targetAccount = payload.accountId
    ? accounts.find((account) => account.is_active && account.id === payload.accountId)
    : signingAccount;
  if (!targetAccount) return c.json({ ok: false }, 404);

  const friend = await upsertFriend(c.env.DB, {
    lineUserId,
    lineAccountId: targetAccount.id,
  });
  const now = jstNow();
  const deliveryType = payload.deliveryType === 'reply' ? 'reply' : 'push';
  const source = payload.source || 'design_bot';

  await c.env.DB.batch(messages.map((message) => {
    const { messageType, content } = mirroredMessageContent(message);
    return c.env.DB.prepare(
      `INSERT INTO messages_log
       (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      friend.id,
      messageType,
      content,
      deliveryType,
      source,
      targetAccount.id,
      now,
    );
  }));

  return c.json({ ok: true, logged: messages.length });
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  proxyDispatch?: HarnessProxyDispatch,
  routingEnv: IemotoRoutingEnv = {},
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    console.log(`[follow] userId=${userId} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    console.log(`[follow] profile=${profile?.displayName ?? 'null'}`);

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      lineAccountId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Resolve referral link (entry_route) for this friend.
    // /auth/callback (OAuth path) writes friends.ref_code in parallel with
    // this follow webhook, so the field can briefly be NULL when LINE
    // delivers the event. Retry a few times (~1s total) before giving up,
    // otherwise override mode and intro pushes silently fall back to the
    // account default whenever the webhook wins the race.
    const { getFriendById } = await import('@line-crm/db');
    let friendRefCode = (friend as { ref_code?: string | null }).ref_code ?? null;
    if (!friendRefCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const refreshed = await getFriendById(db, friend.id);
        const refreshedRef = (refreshed as { ref_code?: string | null } | null)?.ref_code ?? null;
        if (refreshedRef) {
          friendRefCode = refreshedRef;
          break;
        }
      }
    }
    const referralRoute: EntryRoute | null = friendRefCode
      ? await getEntryRouteByRefCode(db, friendRefCode)
      : null;
    const runAccountScenarios =
      !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    // Skip entirely when a referral link explicitly overrides (run_account_friend_add_scenarios=0).
    const scenarios = runAccountScenarios ? await getScenarios(db) : [];
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

          // Immediate delivery: step1 が「now 以前」にスケジュールされる場合のみ
          // replyMessage で即時送信する (reply token は無料・push 枠を消費しない)。
          // - relative + delay_minutes=0 → 即時
          // - elapsed + offset_days=0 + offset_minutes=0 → 即時
          // - absolute_time で過去時刻 → computeNextDeliveryAt が now に clamp するので即時
          // reply 失敗時 (2つ目のシナリオで token 消費済み等) は claim が解放され
          // cron が push で配信する。
          // skipCooldown: 60秒以内の再フォロー (前の enrollment が completed 済み)
          // でも必ず welcome を返す — 旧 webhook 実装のセマンティクスを維持。
          const sent = await pushImmediateFirstStep(
            db,
            friend.id,
            scenario.id,
            { defaultAccessToken: lineAccessToken, workerUrl },
            {
              enrollment: friendScenario,
              reply: { client: lineClient, replyToken: event.replyToken },
              skipCooldown: true,
            },
          );
          if (sent) console.log(`Immediate delivery: sent scenario ${scenario.id} step 1 to ${userId}`);
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // Referral link side-effects (intro push + dedicated scenario)
    if (referralRoute) {
      // Intro push from referral link
      if (referralRoute.intro_template_id) {
        try {
          const template = await getMessageTemplateById(db, referralRoute.intro_template_id);
          if (template) {
            const message = buildMessage(template.message_type, template.message_content);
            await lineClient.pushMessage(userId, [message]);
            console.log(`[follow] referral intro push sent route=${referralRoute.id}`);
          }
        } catch (err) {
          console.error('[follow] referral intro push failed', err);
        }
      }

      // Dedicated scenario enrollment from referral link. A delay-0 first
      // step is pushed immediately (same instant-welcome semantics as
      // friend_add / tag_added enrollments — previously this path always
      // waited for the next cron tick). pushMessage, not reply: the reply
      // token may already be consumed by an account friend_add scenario
      // above, and the intro push on this path uses pushMessage too.
      if (referralRoute.scenario_id) {
        try {
          const enrollment = await enrollFriendInScenario(db, friend.id, referralRoute.scenario_id);
          console.log(`[follow] referral scenario enrolled scenario=${referralRoute.scenario_id}`);
          if (enrollment) {
            await pushImmediateFirstStep(
              db,
              friend.id,
              referralRoute.scenario_id,
              { defaultAccessToken: lineAccessToken, workerUrl },
              { enrollment },
            );
          }
        } catch (err) {
          console.error('[follow] referral scenario enrollment failed', err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false, lineAccountId);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
      }>();

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
    // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
    // delivery_type='push' は厳密には push ではないが、incoming/non-test として
    // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    try {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, postbackData, lineAccountId ?? null, jstNow())
        .run();
    } catch (err) {
      console.error('Failed to log incoming postback', err);
    }

    try {
      if (await markHumanConversationNeedsReply(db, friend.id)) return;
    } catch (error) {
      // Rolling-deploy compatibility: continue with the legacy automation path
      // until the conversation-control migration is available everywhere.
      console.warn('[webhook] conversation control unavailable', error instanceof Error ? error.message : 'unknown');
    }

    let postbackMatched = false;
    let postbackReplyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        postbackMatched = true;
        if (rule.response_type === 'silent') break;
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          postbackReplyTokenConsumed = true;

          // 送信ログ — Rich Menu 経由の Flex 応答もチャット詳細に残るようにする。
          // テキスト auto_reply (line ~390) と同じパターン。
          const { messageToLogPayload: logPayload } = await import('../services/step-delivery.js');
          const replyPayload = logPayload(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
            )
            .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    await fireEvent(db, 'postback_received', {
      friendId: friend.id,
      eventData: { text: postbackData, matched: postbackMatched },
      replyToken: postbackReplyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);
    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
      fileName?: string;
      title?: string;
      packageId?: string | number;
      package_id?: string | number;
      stickerId?: string | number;
      sticker_id?: string | number;
      stickerResourceType?: string | number;
      sticker_resource_type?: string | number;
    };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if (msg.type === 'image' && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT OR IGNORE INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, line_message_id, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?, ?, ?)`,
      )
      .bind(logId, friend.id, msg.type, finalContent, lineAccountId, msg.id, jstNow())
      .run();
    if (await markHumanConversationNeedsReply(db, friend.id)) return;
    if (msg.type === 'image' && await routeToSharedDesignBot(db, {
      friendId: friend.id,
      lineAccountId,
      lineAccessToken,
      event,
    })) return;
    if (msg.type === 'image' &&
        routingEnv.IEMOTO_BOT_ENABLED === 'true' &&
        (!routingEnv.IEMOTO_LINE_ACCOUNT_ID || routingEnv.IEMOTO_LINE_ACCOUNT_ID === lineAccountId)) {
      const imageNow = jstNow();
      await db.prepare(
        `INSERT INTO chats (id, friend_id, status, handling_mode, last_message_at, created_at, updated_at)
         SELECT ?, ?, 'unread', 'bot', ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
      ).bind(crypto.randomUUID(), friend.id, imageNow, imageNow, imageNow, friend.id).run();
      const imageConversation = await db.prepare(
        `SELECT id, version FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(friend.id).first<{ id: string; version: number }>();
      if (imageConversation) {
        const transition = await handoffConversation(db, imageConversation.id, {
          expectedVersion: imageConversation.version,
          idempotencyKey: `image-handoff:${event.webhookEventId || msg.id}`,
          reason: 'customer_image_requires_review', actorType: 'SYSTEM', actorId: null, notifyCustomer: true,
        });
        if (transition.queuedMessageId) await dispatchConversationOutbound(db, transition.queuedMessageId, lineAccessToken);
      }
    }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const redactedIncoming = redactSensitiveText(textMessage.text);
    let incomingText = redactedIncoming.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT OR IGNORE INTO messages_log
         (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source,
          pii_types, contains_sensitive_data, access_level, line_message_id, webhook_event_id,
          line_timestamp, context_group_id, retention_expires_at, line_account_id, quote_token, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?, ?, 'STANDARD', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        logId, friend.id, incomingText, JSON.stringify(redactedIncoming.piiTypes),
        redactedIncoming.containsSensitiveData ? 1 : 0, textMessage.id, event.webhookEventId || null,
        event.timestamp, event.source.type === 'group' ? event.source.groupId : event.source.type === 'room' ? event.source.roomId : null,
        redactedIncoming.containsSensitiveData ? new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString() : null,
        lineAccountId,
        textMessage.quoteToken || null,
        now,
      )
      .run();

    // Stop every automated text branch before forwarding or replying.
    if (await markHumanConversationNeedsReply(db, friend.id)) return;

    // Flow-source helper messages still belong in the customer's conversation.
    // Persist first, then attach the tag and mark the chat unread before stopping
    // automation. The old early return attached the tag but silently discarded
    // the inbound message from Harness.
    const inflowTagName = INFLOW_SOURCE_TAG_BY_MESSAGE[textMessage.text.trim()];
    if (inflowTagName) {
      const inflowTagId = await findTagIdByName(db, inflowTagName);
      if (inflowTagId) {
        await addTagToFriend(db, friend.id, inflowTagId);
      } else {
        console.warn(`[webhook] inflow source tag missing for "${textMessage.text}" -> ${inflowTagName}`);
      }
      await upsertChatOnMessage(db, friend.id);
      return;
    }

    // 「デザイン作成」で開始した30分間だけ共通デザインBotへ中継する。
    // リッチメニューやWebhook所有権は変更せず、Harnessを単一の入口に保つ。
    if (await routeToSharedDesignBot(db, {
      friendId: friend.id,
      lineAccountId,
      lineAccessToken,
      event,
    })) return;

    // タップ時点で開催期間・クリック実績・顧客タグを再評価する。
    // リッチメニューを再公開しなくても、期限切れ非表示と並び替えが反映される。
    if (lineAccountId && incomingText.trim() === 'クーポン・SALE') {
      const couponSale = await buildCouponSaleFlex(db, {
        accountId: lineAccountId,
        friendId: friend.id,
        workerUrl: workerUrl ?? '',
      });
      if (couponSale) {
        await lineClient.replyMessage(event.replyToken, [{
          type: 'flex',
          altText: couponSale.altText,
          contents: couponSale.contents,
        }]);
        await db.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'reply', 'coupon_sale_automation', ?, ?)`,
        ).bind(crypto.randomUUID(), friend.id, JSON.stringify(couponSale.contents), lineAccountId, jstNow()).run();
        return;
      }
    }

    // 人気ランキングは、Next Engineの本番認証と初回同期が完了するまで
    // 推測値やサンプル商品を表示しない。
    if (lineAccountId && incomingText.trim() === '人気ランキング') {
      const rankingState = await db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM next_engine_credentials WHERE id = 'default') AS authorized,
          COALESCE((SELECT baseline_completed FROM next_engine_sync_state WHERE id = 'default'), 0) AS baseline_completed,
          (SELECT last_synced_at FROM next_engine_sync_state WHERE id = 'default') AS last_synced_at
      `).first<{ authorized: number; baseline_completed: number; last_synced_at: string | null }>();
      if (!rankingState?.authorized || !rankingState.baseline_completed || !rankingState.last_synced_at) {
        const pendingText = '人気ランキングは、ただいまNext Engineの販売データと連携準備中です。実データの確認が取れ次第、こちらへ自動で反映します。';
        await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: pendingText }]);
        await db.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', 'next_engine_ranking_pending', ?, ?)`,
        ).bind(crypto.randomUUID(), friend.id, pendingText, lineAccountId, jstNow()).run();
        return;
      }
      const ranking = await db.prepare(`
        SELECT rank, product_code, product_name, image_url, product_url, period_start, period_end
          FROM next_engine_product_rankings
         ORDER BY rank ASC
         LIMIT 10
      `).all<RankingRow>();
      const rows = ranking.results;
      if (rows.length === 0) {
        const emptyText = '直近30日間の楽天市場店の販売データが見つかりませんでした。';
        await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: emptyText }]);
        await db.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', 'next_engine_ranking', ?, ?)`,
        ).bind(crypto.randomUUID(), friend.id, emptyText, lineAccountId, jstNow()).run();
        return;
      }
      const rankingFlex = buildRankingFlex(rows);
      await lineClient.replyMessage(event.replyToken, [{
        type: 'flex',
        altText: '楽天市場店 人気ランキング',
        contents: rankingFlex,
      }]);
      await db.prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'reply', 'next_engine_ranking', ?, ?)`,
      ).bind(crypto.randomUUID(), friend.id, JSON.stringify(rankingFlex), lineAccountId, jstNow()).run();
      return;
    }

    // Variable debounce: combine quick consecutive customer texts, while human
    // handoff, complaints, and safety-sensitive messages bypass the wait.
    const immediate = /人に代わ|スタッフ|担当者|有人|死にたい|自殺|殺す|緊急|クレーム|返金/.test(incomingText);
    if (!immediate) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const recent = await db.prepare(
        `SELECT id, content FROM messages_log
          WHERE friend_id = ? AND direction = 'incoming' AND message_type = 'text'
            AND line_timestamp >= ?
          ORDER BY line_timestamp DESC, created_at DESC LIMIT 5`,
      ).bind(friend.id, event.timestamp - 5_000).all<{ id: string; content: string }>();
      const latest = recent.results[0];
      if (latest && latest.id !== logId) return;
      if (recent.results.length > 1) incomingText = [...recent.results].reverse().map((item) => item.content).join('\n');
    }

    // 家元Bot is an optional downstream service. It never owns the LINE webhook;
    // Harness remains the single reply owner, which prevents duplicate replies.
    let humanHandling = false;
    let authoritativeBotGeneration = 0;
    let iemotoConsultationActive = false;
    let authoritativeConversation: { id: string; version: number } | null = null;
    try {
      await db.prepare(
        `INSERT INTO chats (id, friend_id, status, handling_mode, last_message_at, created_at, updated_at)
         SELECT ?, ?, 'resolved', 'bot', ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
      ).bind(crypto.randomUUID(), friend.id, now, now, now, friend.id).run();
      const handling = await db.prepare(
        `SELECT id, handling_mode, bot_state, bot_generation, version, last_customer_message_at FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(friend.id).first<{ id: string; handling_mode: string; bot_state: string; bot_generation: number; version: number; last_customer_message_at: string | null }>();
      humanHandling = handling?.handling_mode === 'human';
      const consultationStateActive = handling?.bot_state === 'CONSULTING' || handling?.bot_state === 'WAITING_CUSTOMER';
      const lastCustomerMessageAt = handling?.last_customer_message_at
        ? Date.parse(handling.last_customer_message_at)
        : Number.NaN;
      iemotoConsultationActive = Boolean(
        consultationStateActive
        && Number.isFinite(lastCustomerMessageAt)
        && Date.now() - lastCustomerMessageAt <= 10 * 60_000,
      );
      if (handling) {
        const nextBotState = consultationStateActive && !iemotoConsultationActive ? 'IDLE' : handling.bot_state;
        const updatedControl = await db.prepare(
          `UPDATE chats
              SET attention_status = CASE WHEN handling_mode = 'human' THEN 'NEEDS_REPLY' ELSE 'NONE' END,
                  status = CASE WHEN handling_mode = 'human' THEN 'unread' ELSE status END,
                  next_action_at = CASE WHEN handling_mode = 'human' THEN ? ELSE next_action_at END,
                  bot_state = ?, last_customer_message_at = ?, last_message_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?`,
        ).bind(new Date(Date.now() + 10 * 60_000).toISOString(), nextBotState, now, now, now, handling.id, handling.version).run();
        if (Number(updatedControl.meta.changes ?? 0) === 1) {
          authoritativeBotGeneration = handling.bot_generation ?? 0;
          authoritativeConversation = { id: handling.id, version: handling.version + 1 };
        } else {
          const latest = await db.prepare(
            `SELECT id, handling_mode, bot_generation, version FROM chats WHERE id = ?`,
          ).bind(handling.id).first<{ id: string; handling_mode: string; bot_generation: number; version: number }>();
          humanHandling = latest?.handling_mode === 'human';
          authoritativeBotGeneration = latest?.bot_generation ?? handling.bot_generation ?? 0;
          authoritativeConversation = latest ? { id: latest.id, version: latest.version } : null;
        }
      }
    } catch (error) {
      // Rolling deploy / old schema: keep the existing Bot behavior until migration is applied.
      console.warn('[webhook] handling mode lookup skipped', error instanceof Error ? error.message : 'unknown');
    }
    // Once a conversation is under human control, no automated reply path may
    // continue (Iemoto Bot, keyword auto-replies, scenarios, or event actions).
    // The inbound message has already been persisted and marked NEEDS_REPLY.
    if (humanHandling) return;

    if (iemotoConsultationActive && isIemotoDesignGenerationRequest(incomingText)) {
      try {
        await lineClient.pushTextMessage(userId, 'よし、作る。少し待ってくれ。');
        await db.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, 'iemoto_bot', ?, ?)`,
        ).bind(crypto.randomUUID(), friend.id, 'よし、作る。少し待ってくれ。', lineAccountId, jstNow()).run();
      } catch (error) {
        console.warn('[webhook] iemoto generation notice failed', error instanceof Error ? error.message : 'unknown');
      }
    }

    const iemotoResult = humanHandling ? null : await routeToIemotoBotDetailed(routingEnv, {
      lineAccountId,
      lineUserId: userId,
      text: incomingText,
      friend,
      authoritativeControlMode: 'bot',
      authoritativeBotGeneration,
      consultationActive: iemotoConsultationActive,
    });
    if (iemotoResult && authoritativeConversation) {
      await db.prepare(
        `UPDATE chats
            SET bot_state = CASE WHEN handling_mode = 'bot' THEN 'CONSULTING' ELSE bot_state END,
                updated_at = ?
          WHERE id = ? AND handling_mode = 'bot' AND bot_generation = ?`,
      ).bind(jstNow(), authoritativeConversation.id, authoritativeBotGeneration).run();
    }
    if (iemotoResult?.failed && authoritativeConversation) {
      const health = await recordAiFailure(db, lineAccountId);
      const failureUpdate = await db.prepare(
        `UPDATE chats
            SET ai_consecutive_failures = ai_consecutive_failures + 1,
                attention_status = 'NEEDS_REPLY', status = 'unread', version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
      ).bind(jstNow(), authoritativeConversation.id, authoritativeConversation.version).run();
      if (Number(failureUpdate.meta.changes ?? 0) === 1) {
        authoritativeConversation.version += 1;
      }
      const failureRow = await db.prepare(`SELECT ai_consecutive_failures, version FROM chats WHERE id = ?`)
        .bind(authoritativeConversation.id).first<{ ai_consecutive_failures: number; version: number }>();
      if (Number(failureRow?.ai_consecutive_failures ?? 1) >= 3) {
        const transition = await handoffConversation(db, authoritativeConversation.id, {
          expectedVersion: failureRow?.version ?? authoritativeConversation.version,
          idempotencyKey: `ai-failure-handoff:${event.webhookEventId || logId}`,
          reason: 'ai_consecutive_failures', actorType: 'SYSTEM', actorId: null, notifyCustomer: true,
        });
        if (transition.queuedMessageId) await dispatchConversationOutbound(db, transition.queuedMessageId, lineAccessToken);
      } else {
        const failureMessageId = `ai-failure:${event.webhookEventId || logId}`;
        await db.prepare(
          `INSERT OR IGNORE INTO conversation_outbound_messages
           (id, conversation_id, sender_type, message_type, content, status, idempotency_key,
            expected_control_mode, expected_version, expected_bot_generation, delivery_type, created_by, created_at)
           VALUES (?, ?, 'SYSTEM', 'text', ?, 'PENDING', ?, 'bot', ?, ?, 'push', 'ai_health', ?)`,
        ).bind(
          failureMessageId, authoritativeConversation.id,
          health === 'OUTAGE'
            ? '現在、家元Botの応答に障害が発生しています。ご相談内容は保存されています。復旧後に確認します。'
            : 'うまく回答を作れませんでした。ご相談内容は保存されています。もう一度送るか、家元・スタッフへの引き継ぎをお待ちください。',
          `${failureMessageId}:notice`, failureRow?.version ?? authoritativeConversation.version,
          authoritativeBotGeneration, jstNow(),
        ).run();
        await dispatchConversationOutbound(db, failureMessageId, lineAccessToken);
      }
      return;
    }
    if (iemotoResult) {
      await recordAiSuccess(db, lineAccountId);
      await db.prepare(`UPDATE chats SET ai_consecutive_failures = 0 WHERE id = ?`)
        .bind(authoritativeConversation?.id ?? '').run();
    }
    if (iemotoResult?.escalated && authoritativeConversation) {
      const transition = await handoffConversation(db, authoritativeConversation.id, {
        expectedVersion: authoritativeConversation.version,
        idempotencyKey: `bot-handoff:${event.webhookEventId || logId}`,
        reason: iemotoResult.escalationReason || 'bot_requested_handoff',
        actorType: 'BOT',
        actorId: null,
        notifyCustomer: true,
      });
      if (transition.queuedMessageId) {
        await dispatchConversationOutbound(db, transition.queuedMessageId, lineAccessToken);
      }
      return;
    }
    const iemotoReply = iemotoResult?.text ?? null;
    if (iemotoReply && authoritativeConversation) {
      const eventKey = event.webhookEventId || logId;
      const outboundId = `iemoto:${eventKey}`;
      const iemotoImageUrl = iemotoResult?.imageUrl;
      const outboundMessageType = iemotoImageUrl ? 'image_text' : 'text';
      const outboundContent = iemotoImageUrl
        ? JSON.stringify({ text: iemotoReply.slice(0, 4900), imageUrl: iemotoImageUrl })
        : iemotoReply.slice(0, 4900);
      await db.prepare(
        `INSERT OR IGNORE INTO conversation_outbound_messages
         (id, conversation_id, sender_type, message_type, content, status, idempotency_key,
          expected_control_mode, expected_version, expected_bot_generation, delivery_type,
          reply_token, created_by, created_at)
         VALUES (?, ?, 'BOT', ?, ?, 'PENDING', ?, 'bot', ?, ?, 'reply', ?, 'iemoto_bot', ?)`,
      ).bind(
        outboundId, authoritativeConversation.id, outboundMessageType, outboundContent,
        `iemoto-reply:${eventKey}`, authoritativeConversation.version,
        authoritativeBotGeneration, event.replyToken, jstNow(),
      ).run();
      await dispatchConversationOutbound(db, outboundId, lineAccessToken);
      return;
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT COALESCE(f.line_platform_user_id, f.line_user_id) AS line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            await otherClient.pushMessage(other.line_user_id, [buildMessage('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）。
    // silent タイプは返信しないが matched=true になり unread / push を抑止する。
    const { matched, replyTokenConsumed } = await matchAndReply(
      db,
      lineClient,
      friend,
      incomingText,
      event.replyToken,
      {
        lineAccountId,
        workerUrl,
        liffUrl,
        replyMessage: workerUrl
          ? (token, messages) => replyViaHarnessProxy(
              workerUrl,
              lineAccessToken,
              token,
              messages,
              proxyDispatch,
            )
          : undefined,
      },
    );

    // auto_replies にマッチしなかった = 自発メッセージ → unread にする
    if (!matched) {
      await upsertChatOnMessage(db, friend.id);
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export async function retryFailedWebhookEvents(
  env: Env['Bindings'],
  executionCtx: ExecutionContext,
  limit = 20,
): Promise<{ claimed: number; processed: number; failed: number; alreadyStored: number }> {
  const rows = await claimRetryableWebhookEvents(env.DB, limit);
  if (rows.length === 0) return { claimed: 0, processed: 0, failed: 0, alreadyStored: 0 };

  const accounts = await getLineAccounts(env.DB);
  let processed = 0;
  let failed = 0;
  let alreadyStored = 0;

  for (const row of rows) {
    try {
      const event = JSON.parse(row.payload_json) as WebhookEvent;

      // A prior attempt may have persisted the customer message and then failed
      // in a later automation. The chat is already safe; do not reply or fire
      // side effects twice during recovery.
      if (event.type === 'message') {
        const stored = await env.DB.prepare(
          `SELECT id FROM messages_log
            WHERE direction = 'incoming'
              AND (webhook_event_id = ? OR line_message_id = ?)
            LIMIT 1`,
        ).bind(event.webhookEventId || null, event.message.id).first<{ id: string }>();
        if (stored) {
          await completeWebhookEvent(env.DB, row.webhook_event_id);
          alreadyStored++;
          continue;
        }
      }

      const account = row.line_account_id
        ? accounts.find((candidate) => candidate.id === row.line_account_id && candidate.is_active)
        : null;
      const accessToken = account?.channel_access_token || env.LINE_CHANNEL_ACCESS_TOKEN;
      if (!accessToken) throw new Error('LINE access token unavailable for webhook retry');

      const proxyDispatch: HarnessProxyDispatch = (request) =>
        dispatchLineProxyLocally(request, env, executionCtx);
      await handleEvent(
        env.DB,
        new LineClient(accessToken),
        event,
        accessToken,
        row.line_account_id,
        env.WORKER_URL || env.WORKER_PUBLIC_URL,
        env.LIFF_URL,
        env.IMAGES,
        proxyDispatch,
        env,
      );
      await completeWebhookEvent(env.DB, row.webhook_event_id);
      processed++;
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : 'unknown';
      console.error('[webhook-retry] event failed', row.webhook_event_id, reason);
      await failWebhookEvent(env.DB, row.webhook_event_id, reason);
    }
  }

  return { claimed: rows.length, processed, failed, alreadyStored };
}

async function markHumanConversationNeedsReply(db: D1Database, friendId: string): Promise<boolean> {
  const conversation = await db.prepare(
    `SELECT id, handling_mode FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(friendId).first<{ id: string; handling_mode: string }>();
  if (conversation?.handling_mode !== 'human') return false;
  const now = jstNow();
  await db.prepare(
    `UPDATE chats
        SET attention_status = 'NEEDS_REPLY', status = 'unread',
            last_customer_message_at = ?, last_message_at = ?,
            next_action_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND handling_mode = 'human'`,
  ).bind(now, now, new Date(Date.now() + 10 * 60_000).toISOString(), now, conversation.id).run();
  return true;
}

type IemotoRoutingEnv = Pick<Env['Bindings'], 'IEMOTO_BOT_ENABLED' | 'IEMOTO_BOT_BASE_URL' | 'IEMOTO_BOT_SHARED_SECRET' | 'IEMOTO_LINE_ACCOUNT_ID'>;

export async function routeToIemotoBot(
  env: IemotoRoutingEnv,
  input: {
    lineAccountId: string | null;
    lineUserId: string;
    text: string;
    friend: Friend;
    authoritativeControlMode?: 'bot' | 'human';
    authoritativeBotGeneration?: number;
    consultationActive?: boolean;
  },
): Promise<string | null> {
  const result = await routeToIemotoBotDetailed(env, input);
  return result?.text ?? null;
}

type IemotoRouteResult = { text: string | null; imageUrl?: string | null; escalated: boolean; escalationReason?: string; failed?: boolean };

export async function routeToIemotoBotDetailed(
  env: IemotoRoutingEnv,
  input: {
    lineAccountId: string | null;
    lineUserId: string;
    text: string;
    friend: Friend;
    authoritativeControlMode?: 'bot' | 'human';
    authoritativeBotGeneration?: number;
    consultationActive?: boolean;
  },
): Promise<IemotoRouteResult | null> {
  if (env.IEMOTO_BOT_ENABLED !== 'true' || !env.IEMOTO_BOT_BASE_URL) return null;
  if (env.IEMOTO_LINE_ACCOUNT_ID && input.lineAccountId !== env.IEMOTO_LINE_ACCOUNT_ID) return null;
  const shouldRoute = input.consultationActive
    || input.text.trim() === '家元に相談';
  if (!shouldRoute) return null;
  try {
    const response = await fetch(`${env.IEMOTO_BOT_BASE_URL.replace(/\/$/, '')}/line/webhook/local-test`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.IEMOTO_BOT_SHARED_SECRET ? { 'x-iemoto-secret': env.IEMOTO_BOT_SHARED_SECRET } : {}),
      },
      body: JSON.stringify({
        lineUserId: input.lineUserId,
        text: input.text,
        userContext: {
          displayName: input.friend.display_name,
          tags: [],
          recentCategories: [],
          authoritativeControlMode: input.authoritativeControlMode ?? 'bot',
          authoritativeBotGeneration: input.authoritativeBotGeneration ?? 0,
        },
      }),
    });
    if (!response.ok) return { text: null, escalated: false, failed: true };
    const json = await response.json() as {
      action?: string;
      lineText?: string;
      imageUrl?: string | null;
      result?: { escalated?: boolean; escalationReason?: string };
    };
    return {
      text: json.action === 'reply' && json.lineText ? json.lineText : null,
      imageUrl: json.action === 'reply' && /^https:\/\//i.test(json.imageUrl || '') ? json.imageUrl : null,
      escalated: Boolean(json.result?.escalated),
      escalationReason: json.result?.escalationReason,
      failed: false,
    };
  } catch (error) {
    console.error('[webhook] iemoto routing failed', error instanceof Error ? error.message : 'unknown');
    return { text: null, escalated: false, failed: true };
  }
}

export function isIemotoDesignGenerationRequest(text: string): boolean {
  const value = String(text || '').normalize('NFKC').trim();
  return /(それで|それを|これを|この内容で|この案で|今の内容で|この修正で).*(作って|作成して|生成して|画像にして|デザインにして|形にして|作り直して)|^(?:じゃあ[、,\s]*)?(?:この画像で[、,\s]*)?(?:画像(?:を|に)?|デザイン(?:を)?)?(作って|作成して|生成して|画像にして|デザインにして|形にして|作り直して)(よ|ください|くれ|お願い)?[。！!]*$/u.test(value);
}

const SHARED_DESIGN_ACCOUNT_CHANNELS = new Set([
  '2004093583', // おもしろTシャツの俺流総本家 楽天市場店（デザインBot本体）
  '2010637219', // オリジナルグッズ制作（一般）
  '2010637235', // オリジナルグッズで商売推進！（卸）
  '2010637253', // 株式会社太陽 DTF出力
  '2010637265', // 俺流工房〜オリジナルグッズ作成〜
]);
const DESIGN_BOT_CHANNEL_ID = '2004093583';
const DESIGN_BOT_URL = 'https://line-ai-bot-qdl2.onrender.com/internal/harness/design-event';
const DESIGN_BOT_START_TRIGGER = 'AIでデザイン作成をします。※返信に少し時間が掛かる場合があります。';
const DESIGN_BOT_SESSION_MS = 30 * 60_000;
const DESIGN_BOT_REQUEST_TIMEOUT_MS = 35_000;
const DESIGN_BOT_POSTBACKS = new Set(['RM_START', 'RM_GENERAL', 'RM_MAP']);

export function isSharedDesignAccountChannel(channelId: string): boolean {
  return SHARED_DESIGN_ACCOUNT_CHANNELS.has(channelId);
}

function normalizeDesignControlText(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[.．]/gu, '。')
    .trim();
}

export function isDesignBotStartTrigger(text: string): boolean {
  const value = normalizeDesignControlText(text);
  if (value === normalizeDesignControlText(DESIGN_BOT_START_TRIGGER)) return true;
  return /^AIでデザイン作成をします。?※?返信に少し時間が(?:掛|か)かる場合があります。?$/u.test(value);
}

function isDesignBotEndTrigger(text: string): boolean {
  const value = normalizeDesignControlText(text);
  return value === '終了' || value === 'デザイン作成を終了';
}

export async function isSharedDesignSessionActive(
  db: D1Database,
  friendId: string,
  event: WebhookEvent,
): Promise<boolean> {
  if (event.type === 'postback') {
    return DESIGN_BOT_POSTBACKS.has(event.postback.data);
  }
  if (event.type !== 'message') return false;
  if (event.message.type === 'text') {
    const text = (event.message as TextEventMessage).text;
    if (isDesignBotStartTrigger(text)) return true;
    if (isDesignBotEndTrigger(text)) return false;
  }

  const recentMessages = await db.prepare(
    `SELECT content
       FROM messages_log
      WHERE friend_id = ? AND direction = 'incoming' AND message_type = 'text'
        AND line_timestamp >= ?
      ORDER BY line_timestamp DESC, created_at DESC
      LIMIT 30`,
  ).bind(friendId, Date.now() - DESIGN_BOT_SESSION_MS)
    .all<{ content: string }>();
  for (const row of recentMessages.results || []) {
    if (isDesignBotEndTrigger(row.content)) return false;
    if (isDesignBotStartTrigger(row.content)) return true;
  }
  return false;
}

export async function routeToSharedDesignBot(
  db: D1Database,
  input: { friendId: string; lineAccountId: string | null; lineAccessToken: string; event: WebhookEvent },
): Promise<boolean> {
  if (!input.lineAccountId || !['message', 'postback'].includes(input.event.type)) return false;
  if (!await isSharedDesignSessionActive(db, input.friendId, input.event)) return false;
  const row = await db.prepare(
    `SELECT gateway.channel_id AS gateway_channel_id, gateway.channel_secret AS gateway_secret
       FROM line_accounts target
       JOIN line_accounts gateway ON gateway.channel_id = ?
      WHERE target.id = ? AND target.is_active = 1
      LIMIT 1`,
  ).bind(DESIGN_BOT_CHANNEL_ID, input.lineAccountId).first<{
    gateway_channel_id: string;
    gateway_secret: string;
  }>();
  if (!row || !isSharedDesignAccountChannel(row.gateway_channel_id)) return false;

  const payload = JSON.stringify({
    accountId: input.lineAccountId,
    accessToken: input.lineAccessToken,
    event: input.event,
  });
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(row.gateway_secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DESIGN_BOT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(DESIGN_BOT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-design-signature': signature },
      body: payload,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({})) as { handled?: boolean; error?: string };
    if (!response.ok || result.handled !== true || result.error) {
      console.error('[webhook] shared design bot failed an active design session', response.status, result.error || 'declined');
      await replyDesignBotUnavailable(input.lineAccessToken, input.event);
    }
    // An active design session is exclusive. Never fall through to Iemoto Bot,
    // even when the design service declines or temporarily fails.
    return true;
  } catch (error) {
    console.error('[webhook] shared design bot routing failed', error instanceof Error ? error.message : 'unknown');
    await replyDesignBotUnavailable(input.lineAccessToken, input.event);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function replyDesignBotUnavailable(accessToken: string, event: WebhookEvent): Promise<void> {
  if (event.type !== 'message' && event.type !== 'postback') return;
  if (!event.replyToken) return;
  try {
    const client = new LineClient(accessToken);
    await client.replyMessage(event.replyToken, [{
      type: 'text',
      text: '【デザインBot】ただいま処理に時間がかかっています。少し待ってから、もう一度「デザイン作成」を押してください。',
    }]);
  } catch (error) {
    console.error('[webhook] design bot unavailable notice failed', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * auto_reply 行の content/type を resolve する。template_id が set なら templates
 * から取得、参照切れや NULL のときは inline response_content/response_type を使う。
 */
async function resolveAutoReplyContent(
  db: D1Database,
  rule: { template_id: string | null; response_type: string; response_content: string },
): Promise<{ messageType: string; content: string }> {
  if (rule.template_id) {
    const { getTemplateById } = await import('@line-crm/db');
    const tpl = await getTemplateById(db, rule.template_id);
    if (tpl) {
      return { messageType: tpl.message_type, content: tpl.message_content };
    }
  }
  return { messageType: rule.response_type, content: rule.response_content };
}

export { webhook };
