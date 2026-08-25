import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { upsertFriend } from '../src/friends.js';

function d1Adapter(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = sqlite.prepare(sql);
      const prepared = {
        bind(...args: unknown[]) {
          values = args;
          return prepared;
        },
        async run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: result.changes } };
        },
        async first<T>() {
          return (statement.get(...values) as T | undefined) ?? null;
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

function createFriendsDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT UNIQUE NOT NULL,
      line_platform_user_id TEXT,
      line_account_id TEXT,
      display_name TEXT,
      management_nickname TEXT,
      picture_url TEXT,
      status_message TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      first_followed_at TEXT,
      current_follow_started_at TEXT,
      last_followed_at TEXT,
      last_unfollowed_at TEXT,
      unfollow_count INTEGER NOT NULL DEFAULT 0,
      user_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      first_tracked_link_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_friends_account_platform_user
      ON friends(line_account_id, line_platform_user_id);
  `);
  return sqlite;
}

describe('upsertFriend', () => {
  it('persists a first-contact sender with follow tracking timestamps', async () => {
    const sqlite = createFriendsDb();
    const friend = await upsertFriend(d1Adapter(sqlite), {
      lineUserId: 'U-first-contact',
      lineAccountId: 'rakuten',
      displayName: 'First Contact',
      pictureUrl: null,
      statusMessage: null,
    });

    expect(friend.display_name).toBe('First Contact');
    expect(friend.line_account_id).toBe('rakuten');
    expect(friend.line_user_id).toBe('U-first-contact');
    const row = sqlite.prepare(
      'SELECT first_followed_at, current_follow_started_at, last_followed_at FROM friends WHERE id = ?',
    ).get(friend.id) as Record<string, string | null>;
    expect(row.first_followed_at).toBeTruthy();
    expect(row.current_follow_started_at).toBeTruthy();
    expect(row.last_followed_at).toBeTruthy();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 1 });
  });

  it('updates an existing account-scoped friend without binding errors', async () => {
    const sqlite = createFriendsDb();
    sqlite.prepare(`
      INSERT INTO friends
      (id, line_user_id, line_platform_user_id, line_account_id, display_name, is_following, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run('existing', 'rakuten:U-existing', 'U-existing', 'rakuten', 'Old', '2026-01-01', '2026-01-01');

    const friend = await upsertFriend(d1Adapter(sqlite), {
      lineUserId: 'U-existing',
      lineAccountId: 'rakuten',
      displayName: 'Updated',
    });

    expect(friend.id).toBe('existing');
    expect(friend.display_name).toBe('Updated');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 1 });
  });
});
