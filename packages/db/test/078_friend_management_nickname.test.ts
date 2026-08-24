import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('078_friend_management_nickname.sql', () => {
  it('keeps the LINE display name separate from the editable management name', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_user_id TEXT UNIQUE NOT NULL,
        display_name TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO friends (id, line_user_id, display_name, updated_at)
      VALUES ('friend-1', 'U123', 'tsujimoto', '2026-08-24T10:00:00+09:00');
    `);

    db.exec(readFileSync(join(packageRoot, 'migrations', '078_friend_management_nickname.sql'), 'utf8'));
    db.prepare('UPDATE friends SET management_nickname = ? WHERE id = ?')
      .run('辻本 太郎', 'friend-1');
    db.prepare(`
      INSERT INTO friend_nickname_history
        (id, friend_id, previous_nickname, new_nickname, changed_by_staff_id, changed_by_name, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('history-1', 'friend-1', null, '辻本 太郎', 'staff-1', '田中担当', '2026-08-24T10:05:00+09:00');

    expect(db.prepare(`
      SELECT display_name, management_nickname FROM friends WHERE id = ?
    `).get('friend-1')).toEqual({
      display_name: 'tsujimoto',
      management_nickname: '辻本 太郎',
    });
    expect(db.prepare(`
      SELECT previous_nickname, new_nickname, changed_by_name
      FROM friend_nickname_history WHERE friend_id = ?
    `).get('friend-1')).toEqual({
      previous_nickname: null,
      new_nickname: '辻本 太郎',
      changed_by_name: '田中担当',
    });
  });
});
