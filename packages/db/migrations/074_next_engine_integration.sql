-- Read-only Next Engine integration. Tokens never leave the Worker API.
CREATE TABLE IF NOT EXISTS next_engine_credentials (
  id                 TEXT PRIMARY KEY CHECK (id = 'default'),
  company_ne_id      TEXT,
  company_name       TEXT,
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  access_token_end   TEXT,
  refresh_token_end  TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS next_engine_orders (
  receive_order_id        TEXT PRIMARY KEY,
  shop_id                 TEXT,
  shop_cut_form_id        TEXT,
  order_status            TEXT,
  order_date              TEXT,
  last_modified_date      TEXT,
  raw_json                TEXT NOT NULL,
  first_seen_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_seen_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS next_engine_sync_state (
  id                  TEXT PRIMARY KEY CHECK (id = 'default'),
  baseline_completed  INTEGER NOT NULL DEFAULT 0 CHECK (baseline_completed IN (0, 1)),
  last_synced_at      TEXT,
  last_result_json    TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT OR IGNORE INTO next_engine_sync_state (id) VALUES ('default');
