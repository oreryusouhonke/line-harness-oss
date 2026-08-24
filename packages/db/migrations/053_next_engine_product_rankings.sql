CREATE TABLE IF NOT EXISTS next_engine_product_rankings (
  rank          INTEGER PRIMARY KEY,
  product_code  TEXT NOT NULL UNIQUE,
  product_name  TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 0,
  order_count   INTEGER NOT NULL DEFAULT 0,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);
