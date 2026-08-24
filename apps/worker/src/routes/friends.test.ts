import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { friends } from './friends.js';

type Row = Record<string, unknown>;

class FakeStatement {
  bound: unknown[] = [];
  constructor(private db: FakeDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.bound = values; return this; }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('COUNT(*)')) return { count: this.db.friend ? 1 : 0 } as T;
    if (this.sql.includes('FROM friends WHERE id = ?')) return this.db.friend as T | null;
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('friend_nickname_history')) {
      return { results: this.db.history as T[] };
    }
    if (this.sql.includes('FROM friends f')) {
      this.db.lastListSql = this.sql;
      this.db.lastListBinds = this.bound;
      return { results: this.db.friend ? [this.db.friend as T] : [] };
    }
    if (this.sql.includes('FROM friend_tags')) return { results: [] };
    return { results: [] };
  }
  async run() {
    if (this.sql.startsWith('UPDATE friends SET management_nickname')) {
      this.db.friend = { ...this.db.friend!, management_nickname: this.bound[0], updated_at: this.bound[1] };
    }
    if (this.sql.includes('INSERT INTO friend_nickname_history')) {
      this.db.history.unshift({
        id: this.bound[0], friend_id: this.bound[1], previous_nickname: this.bound[2],
        new_nickname: this.bound[3], changed_by_staff_id: this.bound[4],
        changed_by_name: this.bound[5], changed_at: this.bound[6],
      });
    }
    return { success: true };
  }
}

class FakeDb {
  friend: Row | null = null;
  history: Row[] = [];
  lastListSql = '';
  lastListBinds: unknown[] = [];
  prepare(sql: string) { return new FakeStatement(this, sql); }
  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const baseFriend = {
  id: 'friend-1', line_user_id: 'U123', display_name: 'LINE太郎', management_nickname: null,
  picture_url: null, status_message: null, is_following: 1, metadata: '{}', ref_code: null,
  user_id: null, line_account_id: 'account-1', first_tracked_link_id: null,
  created_at: '2026-07-01T10:00:00.000+09:00', updated_at: '2026-07-01T10:00:00.000+09:00',
};

describe('friend management nickname', () => {
  let db: FakeDb;
  let app: Hono;

  beforeEach(() => {
    db = new FakeDb();
    db.friend = { ...baseFriend };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('staff' as never, { id: 'staff-1', name: '田中担当', role: 'staff' } as never);
      await next();
    });
    app.route('/', friends as never);
  });

  test('saves and deletes nickname without changing the LINE display name, with audit history', async () => {
    const save = await app.request('/api/friends/friend-1/management-nickname', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'VIP太郎' }),
    }, { DB: db } as never);
    expect(save.status).toBe(200);
    expect((await save.json() as { data: Row }).data).toMatchObject({
      displayName: 'VIP太郎', lineDisplayName: 'LINE太郎', managementNickname: 'VIP太郎',
    });
    expect(db.friend?.display_name).toBe('LINE太郎');
    expect(db.history[0]).toMatchObject({ new_nickname: 'VIP太郎', changed_by_staff_id: 'staff-1', changed_by_name: '田中担当' });

    const remove = await app.request('/api/friends/friend-1/management-nickname', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: null }),
    }, { DB: db } as never);
    expect((await remove.json() as { data: Row }).data).toMatchObject({
      displayName: 'LINE太郎', lineDisplayName: 'LINE太郎', managementNickname: null,
    });
    expect(db.history[0]).toMatchObject({ previous_nickname: 'VIP太郎', new_nickname: null });
  });

  test('search targets management nickname and LINE display name and prioritizes nickname', async () => {
    db.friend = { ...baseFriend, management_nickname: 'VIP太郎' };
    const response = await app.request('/api/friends?search=太郎&includeTags=false', {}, { DB: db } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { items: Row[] } };
    expect(body.data.items[0]).toMatchObject({
      displayName: 'VIP太郎', lineDisplayName: 'LINE太郎', managementNickname: 'VIP太郎',
    });
    expect(db.lastListSql).toContain('f.management_nickname LIKE ? OR f.display_name LIKE ?');
    expect(db.lastListSql.indexOf('WHEN f.management_nickname')).toBeLessThan(db.lastListSql.indexOf('WHEN f.display_name'));
    expect(db.lastListBinds.filter((value) => value === '%太郎%').length).toBeGreaterThanOrEqual(2);
  });
});
