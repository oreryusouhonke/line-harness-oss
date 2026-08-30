-- Capture real staff/customer exchanges as future AI learning candidates.
-- Nothing in this table is allowed to trigger an automatic LINE reply.
CREATE TABLE IF NOT EXISTS conversation_learning_examples (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  line_account_id TEXT,
  customer_message_id TEXT NOT NULL REFERENCES messages_log(id) ON DELETE CASCADE,
  staff_message_id TEXT NOT NULL REFERENCES messages_log(id) ON DELETE CASCADE,
  customer_reaction_message_id TEXT REFERENCES messages_log(id) ON DELETE SET NULL,
  staff_id TEXT,
  status TEXT NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured', 'approved', 'rejected', 'excluded')),
  exclusion_reason TEXT,
  customer_reacted_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(staff_message_id)
);

CREATE INDEX IF NOT EXISTS idx_learning_examples_conversation
  ON conversation_learning_examples(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_examples_account_status
  ON conversation_learning_examples(line_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_examples_waiting_reaction
  ON conversation_learning_examples(conversation_id, customer_reaction_message_id, created_at DESC);
