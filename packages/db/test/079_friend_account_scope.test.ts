import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('079_friend_account_scope.sql', () => {
  it('preserves existing relations and permits the same LINE user on two accounts', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_user_id TEXT UNIQUE NOT NULL,
        line_account_id TEXT REFERENCES line_accounts(id),
        display_name TEXT
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL REFERENCES friends(id)
      );
      INSERT INTO line_accounts (id) VALUES ('souhonke'), ('kobo');
      INSERT INTO friends (id, line_user_id, line_account_id, display_name)
        VALUES ('friend-souhonke', 'U-kataoka', 'souhonke', '片岡正徳');
      INSERT INTO chats (id, friend_id) VALUES ('chat-existing', 'friend-souhonke');
    `);

    db.exec(readFileSync(join(packageRoot, 'migrations', '079_friend_account_scope.sql'), 'utf8'));
    db.prepare(`
      INSERT INTO friends (id, line_user_id, line_platform_user_id, line_account_id, display_name)
      VALUES (?, ?, ?, ?, ?)
    `).run('friend-kobo', 'kobo:U-kataoka', 'U-kataoka', 'kobo', '片岡正徳');

    const rows = db.prepare(`
      SELECT id, line_account_id, COALESCE(line_platform_user_id, line_user_id) AS actual_user_id
      FROM friends ORDER BY id
    `).all();
    expect(rows).toEqual([
      { id: 'friend-kobo', line_account_id: 'kobo', actual_user_id: 'U-kataoka' },
      { id: 'friend-souhonke', line_account_id: 'souhonke', actual_user_id: 'U-kataoka' },
    ]);
    expect(db.prepare('SELECT friend_id FROM chats WHERE id = ?').get('chat-existing'))
      .toEqual({ friend_id: 'friend-souhonke' });
  });

  it('rejects duplicate records for the same account and LINE user', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_user_id TEXT UNIQUE NOT NULL,
        line_account_id TEXT
      );
      INSERT INTO friends VALUES ('friend-1', 'U-kataoka', 'souhonke');
    `);
    db.exec(readFileSync(join(packageRoot, 'migrations', '079_friend_account_scope.sql'), 'utf8'));

    expect(() => db.prepare(`
      INSERT INTO friends (id, line_user_id, line_platform_user_id, line_account_id)
      VALUES ('friend-2', 'souhonke:U-kataoka', 'U-kataoka', 'souhonke')
    `).run()).toThrow(/UNIQUE constraint failed/);
  });
});
