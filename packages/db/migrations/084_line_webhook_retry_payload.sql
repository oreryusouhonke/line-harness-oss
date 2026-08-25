-- Persist failed LINE webhook payloads so the minute cron can retry ingestion.
-- Successful rows clear payload_json to avoid retaining message content twice.

ALTER TABLE line_webhook_events ADD COLUMN payload_json TEXT;
ALTER TABLE line_webhook_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE line_webhook_events ADD COLUMN next_retry_at TEXT;

CREATE INDEX IF NOT EXISTS idx_line_webhook_events_retry
  ON line_webhook_events(status, next_retry_at, received_at);

-- Prevent a recovered webhook from writing the same inbound LINE message twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_log_incoming_line_message
  ON messages_log(line_account_id, line_message_id)
  WHERE direction = 'incoming' AND line_message_id IS NOT NULL;
