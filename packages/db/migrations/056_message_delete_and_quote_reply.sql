-- Harness-only logical deletion and LINE quote replies.
ALTER TABLE messages_log ADD COLUMN quote_token TEXT;
ALTER TABLE messages_log ADD COLUMN deleted_at TEXT;
ALTER TABLE messages_log ADD COLUMN deleted_by TEXT;
ALTER TABLE conversation_outbound_messages ADD COLUMN quote_token TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_log_visible_friend_created
  ON messages_log(friend_id, deleted_at, created_at);
