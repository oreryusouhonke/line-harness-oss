-- Lightweight chat revision checks run every few seconds in the admin UI.
-- Keep them index-only so unchanged screens do not scan the full chat tables.
CREATE INDEX IF NOT EXISTS idx_chats_updated_at
  ON chats(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_friends_account_updated_at
  ON friends(line_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_log_account_created_at
  ON messages_log(line_account_id, created_at DESC);
