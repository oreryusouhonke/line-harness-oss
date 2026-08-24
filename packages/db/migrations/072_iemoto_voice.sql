CREATE TABLE IF NOT EXISTS iemoto_voice_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  conversation_at TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  emotions_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '{}',
  pii_masked INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS iemoto_voice_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES iemoto_voice_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('IEMOTO_RAW','ASSISTANT_DRAFT','IEMOTO_APPROVED','IEMOTO_REVISED','IEMOTO_REJECTED','FACT_ONLY')),
  category TEXT NOT NULL DEFAULT 'general',
  style_features_json TEXT NOT NULL DEFAULT '{}',
  pii_masked INTEGER NOT NULL DEFAULT 0,
  use_for_style INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS iemoto_voice_evaluations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES iemoto_voice_messages(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  note TEXT,
  evaluator_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS iemoto_style_proposals (
  id TEXT PRIMARY KEY,
  source_evaluation_ids_json TEXT NOT NULL DEFAULT '[]',
  proposed_diff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected','applied')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_iemoto_voice_messages_conversation ON iemoto_voice_messages(conversation_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_iemoto_voice_messages_classification ON iemoto_voice_messages(classification, use_for_style);
