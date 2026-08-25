import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url).href), 'utf8');
}

describe('enqueueHumanReply status transition', () => {
  it('moves a replied conversation from 要対応 to 対応中 in the same guarded update', () => {
    const source = readSource('./conversation-control-store.ts');
    const enqueueUpdate = source.match(
      /export async function enqueueHumanReply[\s\S]*?`UPDATE chats[\s\S]*?WHERE id = \? AND version = \?/
    )?.[0];

    expect(enqueueUpdate).toBeDefined();
    expect(enqueueUpdate).toContain("SET status = 'in_progress', handling_mode = 'human'");
  });

  it('keeps imported LINE history out of the live 要対応 inbox', () => {
    const inboxSource = readSource('./unanswered-inbox.ts');

    expect(inboxSource.match(/line_history_import/g)?.length).toBeGreaterThanOrEqual(4);
    expect(inboxSource.match(/line_history_direct/g)?.length).toBeGreaterThanOrEqual(4);
    expect(inboxSource).toContain("source NOT IN ('postback','line_history_import','line_history_direct')");
    expect(inboxSource).toContain('ml.created_at > li.imported_at');
  });

  it('persists a quote token on queued human replies', () => {
    const source = readSource('./conversation-control-store.ts');
    expect(source).toContain('delivery_type, quote_token, created_by');
    expect(source).toContain('input.quoteToken ?? null');
  });

  it('logically hides only outgoing messages and keeps an audit trail', () => {
    const chatsSource = readSource('../routes/chats.ts');
    expect(chatsSource).toContain("direction = 'outgoing' AND deleted_at IS NULL");
    expect(chatsSource).toContain("'MESSAGE_HIDDEN'");
    expect(chatsSource).toContain('AND deleted_at IS NULL');
  });

  it('resolves quote targets inside the same friend conversation', () => {
    const chatsSource = readSource('../routes/chats.ts');
    expect(chatsSource).toContain('id = ? AND friend_id = ? AND deleted_at IS NULL AND quote_token IS NOT NULL');
    expect(chatsSource).toContain('quoteToken = quoteTarget.quote_token');
  });
});
