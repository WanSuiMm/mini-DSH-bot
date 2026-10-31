CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  harness_session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  profile_id TEXT,
  worker_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'paused', 'lost', 'closed')),
  lease_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner, id)
);

CREATE INDEX IF NOT EXISTS browser_sessions_owner_created_idx
  ON browser_sessions (owner, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS browser_sessions_recovery_idx
  ON browser_sessions (lease_until, id)
  WHERE status IN ('creating', 'active', 'paused');
CREATE INDEX IF NOT EXISTS browser_sessions_profile_idx
  ON browser_sessions (owner, profile_id, lease_until)
  WHERE profile_id IS NOT NULL AND status IN ('creating', 'active', 'paused');

CREATE TABLE IF NOT EXISTS browser_commands (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'ready', 'running', 'succeeded', 'failed', 'unknown', 'rejected')),
  request JSONB NOT NULL,
  result JSONB,
  requires_approval BOOLEAN NOT NULL,
  approval_decision TEXT CHECK (approval_decision IN ('approve', 'reject')),
  approved_at TIMESTAMPTZ,
  worker_id TEXT,
  fence INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, session_id, idempotency_key),
  FOREIGN KEY (owner, session_id) REFERENCES browser_sessions(owner, id) ON DELETE CASCADE,
  CHECK ((status = 'pending_approval' AND approval_decision IS NULL) OR status <> 'pending_approval'),
  CHECK (CASE
    WHEN approval_decision IS NULL THEN approved_at IS NULL
    WHEN approval_decision = 'approve' THEN requires_approval AND approved_at IS NOT NULL
    WHEN approval_decision = 'reject' THEN requires_approval AND approved_at IS NULL
    ELSE FALSE
  END)
);

CREATE INDEX IF NOT EXISTS browser_commands_queue_idx
  ON browser_commands (owner, session_id, created_at, id)
  WHERE status IN ('pending_approval', 'ready', 'running');
CREATE INDEX IF NOT EXISTS browser_commands_session_recent_idx
  ON browser_commands (owner, session_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS browser_events (
  seq BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (owner, session_id) REFERENCES browser_sessions(owner, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS browser_events_session_cursor_idx
  ON browser_events (owner, session_id, seq);
