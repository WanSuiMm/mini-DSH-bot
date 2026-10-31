package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeC1 struct {
	mu                    sync.Mutex
	sessions              map[string]string
	runs                  map[string]map[string]any
	keys                  map[string]string
	startCount            int
	lookupCount           int
	dropNextStart         bool
	loseStartBeforeCommit bool
	badAuth               bool
	eventTypes            []string
	eventCalls            int
	runStatus             string
}

func newFakeC1() *fakeC1 {
	return &fakeC1{sessions: map[string]string{}, runs: map[string]map[string]any{}, keys: map[string]string{}}
}
func (f *fakeC1) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer worker-alice" && r.Header.Get("Authorization") != "Bearer worker-bob" {
		f.mu.Lock()
		f.badAuth = true
		f.mu.Unlock()
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/v1/sessions" {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		id := fmt.Sprintf("remote-session-%d", len(f.sessions)+1)
		f.sessions[id] = fmt.Sprint(in["title"])
		f.mu.Unlock()
		writeJSON(w, http.StatusCreated, map[string]any{"id": id, "title": in["title"]})
		return
	}
	if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/runs") {
		session := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/sessions/"), "/runs")
		key := r.Header.Get("Idempotency-Key")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		if f.loseStartBeforeCommit {
			f.loseStartBeforeCommit = false
			f.mu.Unlock()
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "simulated gateway failure before commit"})
			return
		}
		composite := session + "/" + key
		runID, exists := f.keys[composite]
		replayed := exists
		if !exists {
			f.startCount++
			runID = fmt.Sprintf("remote-run-%d", f.startCount)
			f.keys[composite] = runID
			f.runs[runID] = map[string]any{"id": runID, "session_id": session, "status": "queued", "request": body}
		}
		run := f.runs[runID]
		drop := f.dropNextStart && !exists
		if drop {
			f.dropNextStart = false
		}
		f.mu.Unlock()
		if drop {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "simulated response lost after commit"})
			return
		}
		status := http.StatusAccepted
		if replayed {
			status = http.StatusOK
		}
		writeJSON(w, status, map[string]any{"run": run, "replayed": replayed})
		return
	}
	if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/run-lookup") {
		session := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/sessions/"), "/run-lookup")
		key := r.URL.Query().Get("key")
		f.mu.Lock()
		f.lookupCount++
		id, found := f.keys[session+"/"+key]
		var run map[string]any
		if found {
			run = f.runs[id]
		}
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"found": found, "run": run})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/runs/") {
		rest := strings.TrimPrefix(r.URL.Path, "/v1/runs/")
		parts := strings.Split(rest, "/")
		id, _ := url.PathUnescape(parts[0])
		f.mu.Lock()
		run := f.runs[id]
		f.mu.Unlock()
		if run == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "Run not found"})
			return
		}
		if len(parts) == 1 && r.Method == http.MethodGet {
			result := map[string]any{"summary": map[string]any{"answer": "answer from the actual C1 worker"}, "results": map[string]any{"worker": map[string]any{"ok": true, "data": map[string]any{"text": "worker result"}}}}
			status := f.runStatus
			if status == "" {
				status = "succeeded"
			}
			value := map[string]any{"id": id, "session_id": run["session_id"], "status": status, "request": run["request"], "result": result}
			writeJSON(w, http.StatusOK, value)
			return
		}
		if len(parts) == 2 && parts[1] == "events" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/event-stream")
			after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
			f.mu.Lock()
			f.eventCalls++
			types := append([]string(nil), f.eventTypes...)
			f.mu.Unlock()
			if len(types) == 0 {
				types = []string{"run.queued"}
			}
			for i, eventType := range types {
				eventID := int64(i + 1)
				if eventID <= after {
					continue
				}
				event := map[string]any{"id": eventID, "runId": id, "type": eventType, "payload": map[string]any{"mode": "single"}}
				encoded, _ := json.Marshal(event)
				fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", eventID, eventType, encoded)
			}
			return
		}
		if len(parts) == 2 && parts[1] == "cancel" && r.Method == http.MethodPost {
			writeJSON(w, http.StatusOK, map[string]any{"status": "cancelled"})
			return
		}
	}
	http.NotFound(w, r)
}

func TestEventForwardFailureStopsBatchWithoutAdvancingCursor(t *testing.T) {
	fake := newFakeC1()
	fake.eventTypes = []string{"test.fail", "test.must_not_be_skipped"}
	fake.runStatus = "running"
	service, upstream := newTestService(t, fake)
	if _, err := service.store.db.Exec(`CREATE TRIGGER reject_first_event BEFORE INSERT ON events WHEN NEW.type='test.fail' BEGIN SELECT RAISE(FAIL,'injected event persistence failure'); END`); err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	server := httptest.NewServer(service.Handler())
	t.Cleanup(func() {
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
		upstream.Close()
	})

	session := createSession(t, server.Client(), server.URL, "caller-alice")
	started := postRun(t, server.Client(), server.URL, "caller-alice", session, "event-forward-key", map[string]any{"prompt": "exercise event persistence retry"})
	runID := started["run"].(map[string]any)["id"].(string)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		calls := fake.eventCalls
		fake.mu.Unlock()
		if calls >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	fake.mu.Lock()
	calls := fake.eventCalls
	fake.mu.Unlock()
	if calls < 3 {
		t.Fatalf("worker did not retry the failed event batch: calls=%d", calls)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	run, err := service.store.Run(ctx, "alice", runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.UpstreamCursor != 0 {
		t.Fatalf("failed first event advanced the persisted upstream cursor: %d", run.UpstreamCursor)
	}
	events, err := service.store.Events(ctx, "alice", runID, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == "test.must_not_be_skipped" {
			t.Fatalf("later event was persisted after earlier event failed: %#v", event)
		}
	}
}

func newTestService(t *testing.T, fake *fakeC1, dbPaths ...string) (*Service, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(fake)
	dbPath := filepath.Join(t.TempDir(), "runtime.sqlite")
	if len(dbPaths) > 0 {
		dbPath = dbPaths[0]
	}
	cfg := Config{Listen: "127.0.0.1:0", Database: dbPath, C1BaseURL: upstream.URL, AuthTokens: map[string]string{"caller-alice": "alice", "caller-bob": "bob"}, WorkerTokens: map[string]string{"alice": "worker-alice", "bob": "worker-bob"}, Workers: 2, MaxQueued: 20, MaxQueuedPerOwner: 10, MaxActivePerOwner: 1, PollIntervalMS: 50, UpstreamTimeoutMS: 1000}
	service, err := NewService(cfg)
	if err != nil {
		upstream.Close()
		t.Fatal(err)
	}
	return service, upstream
}

func TestC1ContractDurableQueueIdempotencyAndOwnerBoundary(t *testing.T) {
	fake := newFakeC1()
	service, upstream := newTestService(t, fake)
	service.Start(context.Background())
	server := httptest.NewServer(service.Handler())
	defer func() {
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
		upstream.Close()
	}()
	client := server.Client()
	session := createSession(t, client, server.URL, "caller-alice")
	body := map[string]any{"prompt": "find the answer", "mode": "single", "memoryStrategy": "none", "budget": map[string]any{"maxTokens": 2048, "maxToolCalls": 3, "maxDurationMs": 5000, "maxActiveChildren": 1}}
	started := postRun(t, client, server.URL, "caller-alice", session, "creator-key-1", body)
	runID := started["run"].(map[string]any)["id"].(string)
	var run map[string]any
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run = getRun(t, client, server.URL, "caller-alice", runID)
		if run["status"] == "succeeded" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if run["status"] != "succeeded" {
		t.Fatalf("run did not finish: %#v", run)
	}
	if run["session_id"] != session {
		t.Fatalf("public session id changed: %#v", run)
	}
	result := run["result"].(map[string]any)
	if result["summary"].(map[string]any)["answer"] != "answer from the actual C1 worker" {
		t.Fatalf("upstream result was not forwarded: %#v", result)
	}
	replayed := postRun(t, client, server.URL, "caller-alice", session, "creator-key-1", body)
	if replayed["replayed"] != true || replayed["run"].(map[string]any)["id"] != runID {
		t.Fatalf("idempotent replay differs: %#v", replayed)
	}
	changed := map[string]any{"prompt": "different prompt", "mode": "single", "memoryStrategy": "none", "budget": body["budget"]}
	response := requestJSON(t, client, http.MethodPost, server.URL+"/v1/sessions/"+session+"/runs", "caller-alice", changed, "creator-key-1")
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("same-key payload conflict got %d", response.StatusCode)
	}
	response = requestJSON(t, client, http.MethodGet, server.URL+"/v1/runs/"+runID, "caller-bob", nil, "")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-owner run read got %d", response.StatusCode)
	}
	response = requestJSON(t, client, http.MethodGet, server.URL+"/v1/runs/"+runID+"/events?after=0", "caller-alice", nil, "")
	defer response.Body.Close()
	sse, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(sse), "event: run.queued") || !strings.Contains(string(sse), "\"id\"") || !strings.Contains(string(sse), "\"type\"") {
		t.Fatalf("C1 SSE contract invalid: %d %s", response.StatusCode, sse)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.startCount != 1 {
		t.Fatalf("expected one upstream start, got %d", fake.startCount)
	}
	if fake.badAuth {
		t.Fatal("caller bearer token was forwarded instead of configured worker token")
	}
}

func TestAmbiguousStartSurvivesRestartAndExplicitOriginalKeyReconcile(t *testing.T) {
	fake := newFakeC1()
	fake.dropNextStart = true
	dbPath := filepath.Join(t.TempDir(), "runtime.sqlite")
	service, upstream := newTestService(t, fake, dbPath)
	service.Start(context.Background())
	server := httptest.NewServer(service.Handler())
	client := server.Client()
	stop := func(current *Service, front *httptest.Server) {
		front.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := current.Close(ctx); err != nil {
			t.Fatal(err)
		}
	}
	front := server
	t.Cleanup(func() { stop(service, front); upstream.Close() })
	session := createSession(t, client, server.URL, "caller-alice")
	body := map[string]any{"prompt": "perform one bounded worker run", "mode": "single", "memoryStrategy": "none"}
	started := postRun(t, client, server.URL, "caller-alice", session, "original-user-key", body)
	runID := started["run"].(map[string]any)["id"].(string)
	var run map[string]any
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run = getRun(t, client, server.URL, "caller-alice", runID)
		if run["status"] == "unknown" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if run["status"] != "unknown" {
		fake.mu.Lock()
		startCount, stillDropped := fake.startCount, fake.dropNextStart
		fake.mu.Unlock()
		t.Fatalf("ambiguous start must fail closed as unknown: %#v (startCount=%d dropPending=%v)", run, startCount, stillDropped)
	}
	stop(service, server)
	upstream.Close()
	service2, upstream2 := newTestService(t, fake, dbPath)
	upstream = upstream2
	service = service2
	service.Start(context.Background())
	server2 := httptest.NewServer(service.Handler())
	front = server2
	response := requestJSON(t, server2.Client(), http.MethodPost, server2.URL+"/v1/runs/"+runID+"/reconcile", "caller-alice", map[string]any{}, "")
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("reconcile status %d: %s", response.StatusCode, data)
	}
	run = nil
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run = getRun(t, server2.Client(), server2.URL, "caller-alice", runID)
		if run["status"] == "succeeded" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if run["status"] != "succeeded" {
		t.Fatalf("reconciled run did not complete: %#v", run)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.startCount != 1 {
		t.Fatalf("reconcile dispatched another start instead of attaching to original-key run: %d", fake.startCount)
	}
	if fake.lookupCount != 1 {
		t.Fatalf("expected a run-lookup before resuming, got %d", fake.lookupCount)
	}
	if fake.badAuth {
		t.Fatal("caller bearer token was forwarded to the worker")
	}
}

func TestCancelledUnknownRunDoesNotRestartWhenLookupIsAbsent(t *testing.T) {
	fake := newFakeC1()
	fake.loseStartBeforeCommit = true
	dbPath := filepath.Join(t.TempDir(), "runtime.sqlite")
	service, upstream := newTestService(t, fake, dbPath)
	service.Start(context.Background())
	server := httptest.NewServer(service.Handler())
	front := server
	stop := func(current *Service, currentFront *httptest.Server) {
		currentFront.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := current.Close(ctx); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { stop(service, front); upstream.Close() })
	client := server.Client()
	session := createSession(t, client, server.URL, "caller-alice")
	started := postRun(t, client, server.URL, "caller-alice", session, "cancel-key", map[string]any{"prompt": "must not dispatch after cancellation"})
	runID := started["run"].(map[string]any)["id"].(string)
	var run map[string]any
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run = getRun(t, client, server.URL, "caller-alice", runID)
		if run["status"] == "unknown" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if run["status"] != "unknown" {
		t.Fatalf("expected unknown start: %#v", run)
	}
	cancelResponse := requestJSON(t, client, http.MethodPost, server.URL+"/v1/runs/"+runID+"/cancel", "caller-alice", map[string]any{}, "")
	_ = cancelResponse.Body.Close()
	stop(service, server)
	upstream.Close()
	service2, upstream2 := newTestService(t, fake, dbPath)
	service, upstream, front = service2, upstream2, httptest.NewServer(service2.Handler())
	service.Start(context.Background())
	reconcile := requestJSON(t, front.Client(), http.MethodPost, front.URL+"/v1/runs/"+runID+"/reconcile", "caller-alice", map[string]any{}, "")
	defer reconcile.Body.Close()
	if reconcile.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(reconcile.Body)
		t.Fatalf("cancelled missing-run reconciliation status %d: %s", reconcile.StatusCode, data)
	}
	var value map[string]any
	if err := json.NewDecoder(reconcile.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	if value["run"].(map[string]any)["status"] != "cancelled" {
		t.Fatalf("cancel intent was not preserved: %#v", value)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.startCount != 0 {
		t.Fatalf("cancelled unknown job restarted an upstream effect: starts=%d", fake.startCount)
	}
	if fake.lookupCount != 1 {
		t.Fatalf("expected lookup before choosing not to restart: lookups=%d", fake.lookupCount)
	}
}

func createSession(t *testing.T, c *http.Client, base, token string) string {
	t.Helper()
	response := requestJSON(t, c, http.MethodPost, base+"/v1/sessions", token, map[string]any{"title": "CreatorDesk: test"}, "")
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("create session status %d: %s", response.StatusCode, body)
	}
	var value map[string]any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	id, _ := value["id"].(string)
	if id == "" {
		t.Fatalf("session response missing id: %#v", value)
	}
	return id
}
func postRun(t *testing.T, c *http.Client, base, token, session, key string, body map[string]any) map[string]any {
	t.Helper()
	response := requestJSON(t, c, http.MethodPost, base+"/v1/sessions/"+session+"/runs", token, body, key)
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted && response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("start run status %d: %s", response.StatusCode, data)
	}
	var value map[string]any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
func getRun(t *testing.T, c *http.Client, base, token, id string) map[string]any {
	t.Helper()
	response := requestJSON(t, c, http.MethodGet, base+"/v1/runs/"+id, token, nil, "")
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("get run status %d: %s", response.StatusCode, data)
	}
	var value map[string]any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
func requestJSON(t *testing.T, c *http.Client, method, path, token string, body any, key string) *http.Response {
	t.Helper()
	data, _ := json.Marshal(body)
	request, err := http.NewRequest(method, path, strings.NewReader(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response, err := c.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
