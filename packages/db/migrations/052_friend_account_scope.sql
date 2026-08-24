-- Preserve the legacy globally-unique storage key while adding the real LINE
-- platform user ID as an account-scoped identity. This avoids rebuilding the
-- heavily referenced friends table in D1.
ALTER TABLE friends ADD COLUMN line_platform_user_id TEXT;

UPDATE friends
SET line_platform_user_id = line_user_id
WHERE line_platform_user_id IS NULL;

CREATE UNIQUE INDEX idx_friends_account_platform_user
  ON friends(line_account_id, line_platform_user_id);

CREATE INDEX idx_friends_platform_user
  ON friends(line_platform_user_id);
