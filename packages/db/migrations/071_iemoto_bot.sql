-- Local-first 家元Bot integration data. No automatic customer linking or external writes.
CREATE TABLE IF NOT EXISTS iemoto_customer_links (
  friend_id TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unlinked' CHECK(status IN ('unlinked','verification_pending','candidate','verified','mismatch','staff_review')),
  next_engine_customer_ref TEXT,
  verification_evidence TEXT NOT NULL DEFAULT '[]',
  verified_by TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS iemoto_profiles (
  friend_id TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  consultation_count INTEGER NOT NULL DEFAULT 0,
  last_consulted_at TEXT,
  last_category TEXT,
  recent_summary TEXT,
  staff_handoff_status TEXT NOT NULL DEFAULT 'none',
  auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
  ai_input_tokens INTEGER NOT NULL DEFAULT 0,
  ai_output_tokens INTEGER NOT NULL DEFAULT 0,
  ai_cost_jpy REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS iemoto_memories (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('explicit','purchase_history','inferred','temporary','unconfirmed')),
  confidence TEXT NOT NULL DEFAULT 'unconfirmed',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_iemoto_memories_friend_category ON iemoto_memories(friend_id, category);
