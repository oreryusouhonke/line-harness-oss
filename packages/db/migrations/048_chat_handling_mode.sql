-- Distinguish AI consultation from human takeover per customer chat.
ALTER TABLE chats ADD COLUMN handling_mode TEXT NOT NULL DEFAULT 'bot'
  CHECK (handling_mode IN ('bot', 'human'));

