-- One historical race created this duplicate before chat creation was serialized.
-- The older row has no outbound or audit references; keep the newer row.
DELETE FROM chats WHERE id = '82eb7d25-c549-46fd-bf08-44f35b44fec0';

CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_unique_friend ON chats(friend_id);
