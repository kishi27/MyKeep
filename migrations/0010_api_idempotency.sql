CREATE TABLE api_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  secondary_resource_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
