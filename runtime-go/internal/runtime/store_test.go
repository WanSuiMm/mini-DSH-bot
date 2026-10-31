package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestClaimBoundsTenantConcurrencyAndRecoveryMarksUnknownStart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "jobs.sqlite")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, owner := range []string{"alice", "bob"} {
		if _, err = store.CreateSession(ctx, owner, "session-"+owner, "upstream-"+owner, "test"); err != nil {
			t.Fatal(err)
		}
	}
	request, _ := json.Marshal(map[string]string{"prompt": "bounded"})
	for index, owner := range []string{"alice", "alice", "bob"} {
		sessionID := "session-" + owner
		key := fmt.Sprintf("%s-%d", owner, index)
		if _, _, err = store.CreateRun(ctx, RunInput{Owner: owner, SessionID: sessionID, Key: key, Request: request, DeadlineMS: time.Now().Add(time.Minute).UnixMilli()}, 10, 10); err != nil {
			t.Fatal(err)
		}
	}
	first, err := store.Claim(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Claim(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Owner == second.Owner {
		t.Fatalf("per-owner active cap was exceeded: both claims belong to %s", first.Owner)
	}
	if _, err = store.Claim(ctx, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected no runnable jobs after one slot per owner, got %v", err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	for _, run := range []Run{first, second} {
		recovered, err := store.Run(ctx, run.Owner, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		if recovered.Status != "unknown" {
			t.Fatalf("restart after start intent must not blind-dispatch: got %s", recovered.Status)
		}
	}
}

func TestCancellationInvalidatesAQueuedDispatchClaim(t *testing.T) {
	ctx := context.Background()
	store, err := OpenStore(filepath.Join(t.TempDir(), "cancel.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err = store.CreateSession(ctx, "alice", "session", "upstream-session", "test"); err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(map[string]string{"prompt": "do not start"})
	_, _, err = store.CreateRun(ctx, RunInput{Owner: "alice", SessionID: "session", Key: "cancel-key", Request: request}, 10, 10)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.Claim(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.RequestCancel(ctx, "alice", claimed.ID); err != nil {
		t.Fatal(err)
	}
	allowed, cancelled, err := store.BeginDispatch(ctx, "alice", claimed.ID, claimed.ClaimToken)
	if err != nil {
		t.Fatal(err)
	}
	if allowed || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled claim was dispatched: allowed=%v status=%s", allowed, cancelled.Status)
	}
	if _, err = store.ChangeClaim(ctx, "alice", claimed.ID, "running", "upstream-run", nil, nil, nil, "run.running", map[string]any{}, claimed.ClaimToken); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale claim reopened a cancelled run: %v", err)
	}
}
