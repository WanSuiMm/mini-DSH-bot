package runtime

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrQueueFull = errors.New("queue full")
)

type Store struct{ db *sql.DB }

type Session struct {
	ID         string `json:"id"`
	Owner      string `json:"-"`
	UpstreamID string `json:"-"`
	Title      string `json:"title"`
	Created    string `json:"created"`
}

type Run struct {
	ID              string          `json:"id"`
	SessionID       string          `json:"session_id"`
	Owner           string          `json:"-"`
	Key             string          `json:"-"`
	RequestHash     string          `json:"-"`
	Request         json.RawMessage `json:"request"`
	Status          string          `json:"status"`
	UpstreamID      string          `json:"-"`
	ClaimToken      string          `json:"-"`
	Result          json.RawMessage `json:"result"`
	Error           json.RawMessage `json:"error,omitempty"`
	Created         string          `json:"created"`
	Updated         string          `json:"updated"`
	DeadlineMS      int64           `json:"-"`
	CancelRequested bool            `json:"-"`
	UpstreamCursor  int64           `json:"-"`
}

type StoredEvent struct {
	ID      int64           `json:"id"`
	RunID   string          `json:"runId"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	Created string          `json:"created"`
}

type RunInput struct {
	Owner, SessionID, Key string
	Request               json.RawMessage
	DeadlineMS            int64
}

func OpenStore(path string) (*Store, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, stmt := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000"} {
		if _, err = db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	s := &Store{db: db}
	if err := s.schema(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) schema() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS sessions(owner TEXT NOT NULL,id TEXT NOT NULL,upstream_id TEXT NOT NULL,title TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(owner,id));
CREATE TABLE IF NOT EXISTS runs(owner TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,request_json BLOB NOT NULL,status TEXT NOT NULL,upstream_id TEXT NOT NULL DEFAULT '',result_json BLOB,error_json BLOB,created TEXT NOT NULL,updated TEXT NOT NULL,deadline_ms INTEGER NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,upstream_cursor INTEGER NOT NULL DEFAULT 0,claim_token TEXT NOT NULL DEFAULT '',PRIMARY KEY(owner,id),UNIQUE(owner,session_id,idempotency_key),FOREIGN KEY(owner,session_id) REFERENCES sessions(owner,id));
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(status,created,id);
CREATE INDEX IF NOT EXISTS runs_owner_status_idx ON runs(owner,status);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,run_id TEXT NOT NULL,type TEXT NOT NULL,payload_json BLOB NOT NULL,created TEXT NOT NULL,FOREIGN KEY(owner,run_id) REFERENCES runs(owner,id));
CREATE INDEX IF NOT EXISTS events_run_idx ON events(owner,run_id,id);`)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(`PRAGMA table_info(runs)`)
	if err != nil {
		return err
	}
	hasClaimToken := false
	for rows.Next() {
		var cid, notNull, primary int
		var name, columnType string
		var defaultValue any
		if err = rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primary); err != nil {
			rows.Close()
			return err
		}
		if name == "claim_token" {
			hasClaimToken = true
		}
	}
	if err = rows.Close(); err != nil {
		return err
	}
	if !hasClaimToken {
		if _, err = s.db.Exec(`ALTER TABLE runs ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, owner, id, upstreamID, title string) (Session, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions(owner,id,upstream_id,title,created) VALUES(?,?,?,?,?)`, owner, id, upstreamID, title, now)
	if err != nil {
		return Session{}, err
	}
	return Session{ID: id, Owner: owner, UpstreamID: upstreamID, Title: title, Created: now}, nil
}

func (s *Store) Session(ctx context.Context, owner, id string) (Session, error) {
	var v Session
	err := s.db.QueryRowContext(ctx, `SELECT id,owner,upstream_id,title,created FROM sessions WHERE owner=? AND id=?`, owner, id).Scan(&v.ID, &v.Owner, &v.UpstreamID, &v.Title, &v.Created)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return v, err
}

func (s *Store) CreateRun(ctx context.Context, in RunInput, maxQueue, maxOwnerQueue int) (Run, bool, error) {
	requestHash := sha256.Sum256(in.Request)
	hashText := hex.EncodeToString(requestHash[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, false, err
	}
	defer tx.Rollback()
	var existing Run
	err = scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE owner=? AND session_id=? AND idempotency_key=?`, in.Owner, in.SessionID, in.Key), &existing)
	if err == nil {
		if existing.RequestHash != hashText {
			return Run{}, false, ErrConflict
		}
		if err = tx.Commit(); err != nil {
			return Run{}, false, err
		}
		return existing, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Run{}, false, err
	}
	var globalQueued, ownerQueued int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM runs WHERE status='queued'`).Scan(&globalQueued); err != nil {
		return Run{}, false, err
	}
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM runs WHERE owner=? AND status='queued'`, in.Owner).Scan(&ownerQueued); err != nil {
		return Run{}, false, err
	}
	if globalQueued >= maxQueue || ownerQueued >= maxOwnerQueue {
		return Run{}, false, ErrQueueFull
	}
	id := newID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = tx.ExecContext(ctx, `INSERT INTO runs(owner,id,session_id,idempotency_key,request_hash,request_json,status,created,updated,deadline_ms) VALUES(?,?,?,?,?,?, 'queued',?,?,?)`, in.Owner, id, in.SessionID, in.Key, hashText, []byte(in.Request), now, now, in.DeadlineMS)
	if err != nil {
		return Run{}, false, err
	}
	run := Run{Owner: in.Owner, ID: id, SessionID: in.SessionID, Key: in.Key, RequestHash: hashText, Request: append([]byte(nil), in.Request...), Status: "queued", Created: now, Updated: now, DeadlineMS: in.DeadlineMS}
	if _, err = appendEventTx(ctx, tx, run, "run.queued", json.RawMessage(`{}`)); err != nil {
		return Run{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, false, err
	}
	return run, false, nil
}

const runColumns = `owner,id,session_id,idempotency_key,request_hash,request_json,status,upstream_id,result_json,error_json,created,updated,deadline_ms,cancel_requested,upstream_cursor,claim_token`

type scanner interface{ Scan(...any) error }

func scanRun(row scanner, v *Run) error {
	var req, result, fail []byte
	var cancel int
	err := row.Scan(&v.Owner, &v.ID, &v.SessionID, &v.Key, &v.RequestHash, &req, &v.Status, &v.UpstreamID, &result, &fail, &v.Created, &v.Updated, &v.DeadlineMS, &cancel, &v.UpstreamCursor, &v.ClaimToken)
	if err != nil {
		return err
	}
	v.Request = append([]byte(nil), req...)
	if result != nil {
		v.Result = append([]byte(nil), result...)
	}
	if fail != nil {
		v.Error = append([]byte(nil), fail...)
	}
	v.CancelRequested = cancel != 0
	return nil
}

func (s *Store) Run(ctx context.Context, owner, id string) (Run, error) {
	var v Run
	err := scanRun(s.db.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE owner=? AND id=?`, owner, id), &v)
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return v, err
}

func (s *Store) SetDeadlineClaim(ctx context.Context, owner, id string, deadlineMS int64, claimToken string) (Run, error) {
	if claimToken == "" {
		return Run{}, ErrConflict
	}
	result, err := s.db.ExecContext(ctx, `UPDATE runs SET deadline_ms=?,updated=? WHERE owner=? AND id=? AND status IN ('starting','cancelling') AND claim_token=?`, deadlineMS, time.Now().UTC().Format(time.RFC3339Nano), owner, id, claimToken)
	if err != nil {
		return Run{}, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return Run{}, err
	}
	if changed == 0 {
		return Run{}, ErrConflict
	}
	return s.Run(ctx, owner, id)
}

func (s *Store) FindByKey(ctx context.Context, owner, session, key string) (Run, error) {
	var v Run
	err := scanRun(s.db.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE owner=? AND session_id=? AND idempotency_key=?`, owner, session, key), &v)
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return v, err
}

func (s *Store) Claim(ctx context.Context, ownerActive int) (Run, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	var v Run
	err = scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE status='queued' AND (SELECT COUNT(*) FROM runs a WHERE a.owner=r.owner AND a.status IN ('starting','running','cancelling','unknown')) < ? ORDER BY created,id LIMIT 1`, ownerActive), &v)
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	token := newID()
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='starting',updated=?,claim_token=? WHERE owner=? AND id=? AND status='queued'`, now, token, v.Owner, v.ID); err != nil {
		return Run{}, err
	}
	v.Status = "starting"
	v.Updated = now
	v.ClaimToken = token
	if _, err = appendEventTx(ctx, tx, v, "run.starting", json.RawMessage(`{}`)); err != nil {
		return Run{}, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, err
	}
	return v, nil
}

func (s *Store) BeginDispatch(ctx context.Context, owner, id, claimToken string) (bool, Run, error) {
	if claimToken == "" {
		return false, Run{}, ErrConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, Run{}, err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, id)
	if err != nil {
		return false, Run{}, err
	}
	if (run.Status != "starting" && run.Status != "cancelling") || run.ClaimToken != claimToken {
		return false, run, ErrConflict
	}
	if run.CancelRequested || run.Status == "cancelling" {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		run.Status, run.Updated, run.ClaimToken = "cancelled", now, ""
		if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='cancelled',updated=?,claim_token='' WHERE owner=? AND id=? AND claim_token=?`, now, owner, id, claimToken); err != nil {
			return false, Run{}, err
		}
		if _, err = appendEventTx(ctx, tx, run, "run.cancelled", json.RawMessage(`{"reason":"cancelled_before_upstream_start"}`)); err != nil {
			return false, Run{}, err
		}
		if err = tx.Commit(); err != nil {
			return false, Run{}, err
		}
		return false, run, nil
	}
	if err = tx.Commit(); err != nil {
		return false, Run{}, err
	}
	return true, run, nil
}

func appendEventTx(ctx context.Context, tx *sql.Tx, run Run, kind string, payload json.RawMessage) (StoredEvent, error) {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.ExecContext(ctx, `INSERT INTO events(owner,run_id,type,payload_json,created) VALUES(?,?,?,?,?)`, run.Owner, run.ID, kind, []byte(payload), now)
	if err != nil {
		return StoredEvent{}, err
	}
	id, _ := result.LastInsertId()
	return StoredEvent{ID: id, RunID: run.ID, Type: kind, Payload: append([]byte(nil), payload...), Created: now}, nil
}

func (s *Store) Emit(ctx context.Context, owner, runID, kind string, payload any) (StoredEvent, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return StoredEvent{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StoredEvent{}, err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, runID)
	if err != nil {
		return StoredEvent{}, err
	}
	event, err := appendEventTx(ctx, tx, run, kind, raw)
	if err != nil {
		return StoredEvent{}, err
	}
	if err = tx.Commit(); err != nil {
		return StoredEvent{}, err
	}
	return event, nil
}

func (s *Store) RunTx(ctx context.Context, tx *sql.Tx, owner, id string) (Run, error) {
	var v Run
	err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE owner=? AND id=?`, owner, id), &v)
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return v, err
}

func (s *Store) Change(ctx context.Context, owner, id, status, upstreamID string, result, errorValue any, cursor *int64, kind string, payload any) (Run, error) {
	return s.change(ctx, owner, id, status, upstreamID, result, errorValue, cursor, kind, payload, "", false)
}

func (s *Store) ChangeClaim(ctx context.Context, owner, id, status, upstreamID string, result, errorValue any, cursor *int64, kind string, payload any, claimToken string) (Run, error) {
	if claimToken == "" {
		return Run{}, ErrConflict
	}
	return s.change(ctx, owner, id, status, upstreamID, result, errorValue, cursor, kind, payload, claimToken, true)
}

func (s *Store) change(ctx context.Context, owner, id, status, upstreamID string, result, errorValue any, cursor *int64, kind string, payload any, claimToken string, requireClaim bool) (Run, error) {
	var resultJSON, errorJSON []byte
	var err error
	if result != nil {
		resultJSON, err = json.Marshal(result)
		if err != nil {
			return Run{}, err
		}
	}
	if errorValue != nil {
		errorJSON, err = json.Marshal(errorValue)
		if err != nil {
			return Run{}, err
		}
	}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return Run{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, id)
	if err != nil {
		return Run{}, err
	}
	if requireClaim && run.ClaimToken != claimToken {
		return Run{}, ErrConflict
	}
	if cursor != nil {
		run.UpstreamCursor = *cursor
	}
	if upstreamID != "" {
		run.UpstreamID = upstreamID
	}
	run.Status = status
	run.Updated = now
	if resultJSON != nil {
		run.Result = resultJSON
	}
	run.Error = errorJSON
	clearClaim := status != "starting" && status != "running" && status != "cancelling"
	if clearClaim {
		run.ClaimToken = ""
	}
	_, err = tx.ExecContext(ctx, `UPDATE runs SET status=?,upstream_id=?,result_json=COALESCE(?,result_json),error_json=?,updated=?,upstream_cursor=COALESCE(?,upstream_cursor),claim_token=CASE WHEN ? THEN '' ELSE claim_token END WHERE owner=? AND id=?`, status, run.UpstreamID, nullBytes(resultJSON), nullBytes(errorJSON), now, nullInt64(cursor), clearClaim, owner, id)
	if err != nil {
		return Run{}, err
	}
	if kind != "" {
		if _, err = appendEventTx(ctx, tx, run, kind, rawPayload); err != nil {
			return Run{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Store) ForwardEvent(ctx context.Context, owner, runID string, upstreamCursor int64, kind string, payload any) error {
	return s.forwardEvent(ctx, owner, runID, upstreamCursor, kind, payload, "", false)
}

func (s *Store) ForwardEventClaim(ctx context.Context, owner, runID string, upstreamCursor int64, kind string, payload any, claimToken string) error {
	if claimToken == "" {
		return ErrConflict
	}
	return s.forwardEvent(ctx, owner, runID, upstreamCursor, kind, payload, claimToken, true)
}

func (s *Store) forwardEvent(ctx context.Context, owner, runID string, upstreamCursor int64, kind string, payload any, claimToken string, requireClaim bool) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, runID)
	if err != nil {
		return err
	}
	if requireClaim && run.ClaimToken != claimToken {
		return ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET upstream_cursor=MAX(upstream_cursor,?) WHERE owner=? AND id=?`, upstreamCursor, owner, runID); err != nil {
		return err
	}
	if _, err = appendEventTx(ctx, tx, run, kind, raw); err != nil {
		return err
	}
	return tx.Commit()
}

func nullBytes(value []byte) any {
	if value == nil {
		return nil
	}
	return value
}
func nullInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func (s *Store) Recover(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT `+runColumns+` FROM runs WHERE status IN ('starting','running','cancelling')`)
	if err != nil {
		return err
	}
	var list []Run
	for rows.Next() {
		var v Run
		if err = scanRun(rows, &v); err != nil {
			rows.Close()
			return err
		}
		list = append(list, v)
	}
	if err = rows.Close(); err != nil {
		return err
	}
	for _, run := range list {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if run.UpstreamID == "" {
			run.Status = "unknown"
			_, err = tx.ExecContext(ctx, `UPDATE runs SET status='unknown',updated=?,claim_token='' WHERE owner=? AND id=?`, now, run.Owner, run.ID)
			if err == nil {
				_, err = appendEventTx(ctx, tx, run, "run.unknown", json.RawMessage(`{"reason":"restart_during_upstream_start"}`))
			}
		} else {
			run.Status = "queued"
			_, err = tx.ExecContext(ctx, `UPDATE runs SET status='queued',updated=?,claim_token='' WHERE owner=? AND id=?`, now, run.Owner, run.ID)
			if err == nil {
				_, err = appendEventTx(ctx, tx, run, "run.recovered", json.RawMessage(`{"strategy":"resume_upstream_run"}`))
			}
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) CancelQueued(ctx context.Context, owner, id string) (Run, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, false, err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, id)
	if err != nil {
		return Run{}, false, err
	}
	if run.Status != "queued" {
		return run, false, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	run.Status = "cancelled"
	run.Updated = now
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='cancelled',updated=? WHERE owner=? AND id=? AND status='queued'`, now, owner, id); err != nil {
		return Run{}, false, err
	}
	if _, err = appendEventTx(ctx, tx, run, "run.cancelled", json.RawMessage(`{}`)); err != nil {
		return Run{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, false, err
	}
	return run, true, nil
}

func (s *Store) RequestCancel(ctx context.Context, owner, id string) (Run, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, id)
	if err != nil {
		return Run{}, err
	}
	if run.Status == "unknown" {
		if run.CancelRequested {
			return run, nil
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		run.Updated = now
		run.CancelRequested = true
		if _, err = tx.ExecContext(ctx, `UPDATE runs SET cancel_requested=1,updated=? WHERE owner=? AND id=?`, now, owner, id); err != nil {
			return Run{}, err
		}
		if _, err = appendEventTx(ctx, tx, run, "run.cancel_requested", json.RawMessage(`{"status":"unknown"}`)); err != nil {
			return Run{}, err
		}
		if err = tx.Commit(); err != nil {
			return Run{}, err
		}
		return run, nil
	}
	if run.Status == "failed" || run.Status == "succeeded" || run.Status == "partial" || run.Status == "cancelled" || run.Status == "timed_out" {
		return run, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	run.Status = "cancelling"
	run.Updated = now
	run.CancelRequested = true
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='cancelling',cancel_requested=1,updated=? WHERE owner=? AND id=?`, now, owner, id); err != nil {
		return Run{}, err
	}
	if _, err = appendEventTx(ctx, tx, run, "run.cancelling", json.RawMessage(`{}`)); err != nil {
		return Run{}, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Store) BeginReconcile(ctx context.Context, owner, id string) (Run, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	run, err := s.RunTx(ctx, tx, owner, id)
	if err != nil {
		return Run{}, err
	}
	if run.Status != "unknown" {
		return Run{}, ErrConflict
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	token := newID()
	run.Status = "starting"
	run.Updated = now
	run.ClaimToken = token
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='starting',updated=?,claim_token=? WHERE owner=? AND id=? AND status='unknown'`, now, token, owner, id); err != nil {
		return Run{}, err
	}
	if _, err = appendEventTx(ctx, tx, run, "run.reconciling", json.RawMessage(`{}`)); err != nil {
		return Run{}, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Store) Events(ctx context.Context, owner, runID string, after int64, limit int) ([]StoredEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,run_id,type,payload_json,created FROM events WHERE owner=? AND run_id=? AND id>? ORDER BY id LIMIT ?`, owner, runID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredEvent
	for rows.Next() {
		var e StoredEvent
		var payload []byte
		if err = rows.Scan(&e.ID, &e.RunID, &e.Type, &payload, &e.Created); err != nil {
			return nil, err
		}
		e.Payload = append([]byte(nil), payload...)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) Counts(ctx context.Context) (queued, active, unknown int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN status IN ('starting','running','cancelling') THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END),0) FROM runs`).Scan(&queued, &active, &unknown)
	if err != nil {
		return 0, 0, 0, err
	}
	return
}
func (s *Store) OwnerCounts(ctx context.Context, owner string) (queued, active, unknown int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN status IN ('starting','running','cancelling') THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END),0) FROM runs WHERE owner=?`, owner).Scan(&queued, &active, &unknown)
	if err != nil {
		return 0, 0, 0, err
	}
	return
}
func (s *Store) Close() error { return s.db.Close() }

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto random source unavailable")
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
