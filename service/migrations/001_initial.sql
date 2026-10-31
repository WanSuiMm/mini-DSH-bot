CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  owner text NOT NULL,
  title text NOT NULL,
  created timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  owner text NOT NULL,
  status text NOT NULL,
  request jsonb NOT NULL,
  result jsonb,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created timestamptz NOT NULL,
  updated timestamptz NOT NULL,
  lease_owner text,
  lease_expires timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  cancel_requested_at timestamptz,
  UNIQUE(session_id, idempotency_key)
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS tasks (
  id text NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  record jsonb NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  seq bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  namespace text NOT NULL,
  id text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY(namespace, id)
);

CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, created, id);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions(owner, created DESC);
