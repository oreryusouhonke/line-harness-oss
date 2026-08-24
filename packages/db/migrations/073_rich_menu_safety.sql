-- Rich-menu safety: immutable operation/error history and JSON snapshots.
CREATE TABLE IF NOT EXISTS rich_menu_operation_logs (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  group_id      TEXT,
  staff_id      TEXT,
  operation     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('success','error')),
  richmenu_id   TEXT,
  before_json   TEXT,
  after_json    TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_rich_menu_operation_logs_account
  ON rich_menu_operation_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rich_menu_operation_logs_group
  ON rich_menu_operation_logs(group_id, created_at DESC);
