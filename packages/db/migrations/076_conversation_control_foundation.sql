-- Safe, additive foundation for authoritative conversation control.
-- Rollback: deploy the previous Worker. All added columns/tables are ignored by old code.

ALTER TABLE chats ADD COLUMN bot_state TEXT NOT NULL DEFAULT 'IDLE'
  CHECK (bot_state IN ('IDLE','CONSULTING','WAITING_CUSTOMER','HANDOFF_REQUESTED','PAUSED','CLOSED'));
ALTER TABLE chats ADD COLUMN previous_bot_state TEXT;
ALTER TABLE chats ADD COLUMN attention_status TEXT NOT NULL DEFAULT 'NONE'
  CHECK (attention_status IN ('NONE','NEEDS_REPLY','WAITING_CUSTOMER','WAITING_BUSINESS_HOURS','OVERDUE','URGENT','RESOLVED'));
ALTER TABLE chats ADD COLUMN priority TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT'));
ALTER TABLE chats ADD COLUMN assigned_staff_id TEXT;
ALTER TABLE chats ADD COLUMN lock_owner_id TEXT;
ALTER TABLE chats ADD COLUMN lock_expires_at TEXT;
ALTER TABLE chats ADD COLUMN bot_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN last_customer_message_at TEXT;
ALTER TABLE chats ADD COLUMN last_reply_at TEXT;
ALTER TABLE chats ADD COLUMN next_action_at TEXT;
ALTER TABLE chats ADD COLUMN available_at TEXT;
ALTER TABLE chats ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chats ADD COLUMN ai_consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages_log ADD COLUMN pii_types TEXT;
ALTER TABLE messages_log ADD COLUMN contains_sensitive_data INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages_log ADD COLUMN access_level TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE messages_log ADD COLUMN retention_expires_at TEXT;
ALTER TABLE messages_log ADD COLUMN line_message_id TEXT;
ALTER TABLE messages_log ADD COLUMN webhook_event_id TEXT;
ALTER TABLE messages_log ADD COLUMN line_timestamp INTEGER;
ALTER TABLE messages_log ADD COLUMN context_group_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chats_control_queue
  ON chats(handling_mode, attention_status, priority, last_customer_message_at);
CREATE INDEX IF NOT EXISTS idx_chats_assigned_staff ON chats(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_chats_lock_expiry ON chats(lock_expires_at);

CREATE TABLE IF NOT EXISTS conversation_operation_keys (
  idempotency_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_operation_expiry
  ON conversation_operation_keys(expires_at);

CREATE TABLE IF NOT EXISTS conversation_state_transitions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_mode TEXT NOT NULL,
  to_mode TEXT NOT NULL,
  from_bot_state TEXT NOT NULL,
  to_bot_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  performed_by_type TEXT NOT NULL,
  performed_by_id TEXT,
  request_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_transition_chat
  ON conversation_state_transitions(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_transition_version
  ON conversation_state_transitions(conversation_id, to_version);

CREATE TABLE IF NOT EXISTS conversation_audit_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  request_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_audit_chat
  ON conversation_audit_logs(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_outbound_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('BOT','HUMAN','SYSTEM')),
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENDING','SENT','FAILED','CANCELLED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_control_mode TEXT NOT NULL CHECK (expected_control_mode IN ('bot','human')),
  expected_version INTEGER NOT NULL,
  expected_bot_generation INTEGER NOT NULL,
  delivery_type TEXT NOT NULL DEFAULT 'push' CHECK (delivery_type IN ('push','reply')),
  reply_token TEXT,
  line_request_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversation_outbound_pending
  ON conversation_outbound_messages(status, created_at);

CREATE TABLE IF NOT EXISTS line_webhook_events (
  webhook_event_id TEXT PRIMARY KEY,
  line_account_id TEXT,
  event_type TEXT NOT NULL,
  is_redelivery INTEGER NOT NULL DEFAULT 0,
  line_timestamp INTEGER,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING','PROCESSED','FAILED')),
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_line_webhook_events_received
  ON line_webhook_events(received_at);

CREATE TABLE IF NOT EXISTS ai_service_health (
  service_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'NORMAL' CHECK (status IN ('NORMAL','DEGRADED','OUTAGE')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);
