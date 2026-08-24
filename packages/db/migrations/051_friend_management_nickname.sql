-- Management-only friend nickname. LINE's display_name remains authoritative and untouched.
ALTER TABLE friends ADD COLUMN management_nickname TEXT;

CREATE TABLE friend_nickname_history (
  id                  TEXT PRIMARY KEY,
  friend_id           TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  previous_nickname   TEXT,
  new_nickname        TEXT,
  changed_by_staff_id TEXT NOT NULL,
  changed_by_name     TEXT NOT NULL,
  changed_at          TEXT NOT NULL
);

CREATE INDEX idx_friend_nickname_history_friend
  ON friend_nickname_history(friend_id, changed_at DESC);

CREATE INDEX idx_friends_management_nickname
  ON friends(management_nickname);
