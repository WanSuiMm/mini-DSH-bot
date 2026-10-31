package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Service struct {
	cfg         Config
	store       *Store
	upstream    *C1Client
	owners      []tokenOwner
	mux         sync.Mutex
	started     bool
	rootCancel  context.CancelFunc
	workers     sync.WaitGroup
	requests    atomic.Int64
	errors      atomic.Int64
	runsStarted atomic.Int64
	completed   atomic.Int64
}

func NewService(cfg Config) (*Service, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	store, err := OpenStore(cfg.Database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = store.Recover(ctx); err != nil {
		store.Close()
		return nil, err
	}
	return &Service{cfg: cfg, store: store, upstream: NewC1Client(cfg.C1BaseURL, cfg.WorkerTokens, time.Duration(cfg.UpstreamTimeoutMS)*time.Millisecond), owners: tokenEntries(cfg.AuthTokens)}, nil
}

func (s *Service) Handler() http.Handler { return http.HandlerFunc(s.handle) }

func (s *Service) Start(parent context.Context) {
	s.mux.Lock()
	defer s.mux.Unlock()
	if s.started {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.rootCancel = cancel
	s.started = true
	for i := 0; i < s.cfg.Workers; i++ {
		s.workers.Add(1)
		go s.worker(ctx)
	}
}

func (s *Service) Close(ctx context.Context) error {
	s.mux.Lock()
	cancel := s.rootCancel
	s.mux.Unlock()
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() { s.workers.Wait(); close(done) }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		return s.store.Close()
	}
}

func (s *Service) handle(w http.ResponseWriter, r *http.Request) {
	s.requests.Add(1)
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "backend": "sqlite"})
		return
	}
	owner, ok := ownerForBearer(r.Header.Get("Authorization"), s.owners)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Authentication required"})
		return
	}
	ctx := r.Context()
	path := strings.TrimSuffix(r.URL.Path, "/")
	if path == "" {
		path = "/"
	}
	if path == "/v1/sessions" && r.Method == http.MethodPost {
		s.createSession(w, r, owner)
		return
	}
	if path == "/v1/metrics" && r.Method == http.MethodGet {
		queued, active, unknown, err := s.store.OwnerCounts(ctx, owner)
		if err != nil {
			s.internalError(w)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"requests": s.requests.Load(), "errors": s.errors.Load(), "runsStarted": s.runsStarted.Load(), "completed": s.completed.Load(), "activeRuns": active, "queuedRuns": queued, "unknownRuns": unknown})
		return
	}
	if strings.HasPrefix(path, "/v1/sessions/") {
		s.sessionRoute(w, r, owner, path)
		return
	}
	if strings.HasPrefix(path, "/v1/runs/") {
		s.runRoute(w, r, owner, path)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "Route not found"})
}

func (s *Service) createSession(w http.ResponseWriter, r *http.Request, owner string) {
	body, err := s.readBody(r)
	if err != nil {
		s.clientError(w, err)
		return
	}
	var input struct {
		Title string `json:"title"`
	}
	if json.Unmarshal(body, &input) != nil || len([]rune(input.Title)) > 200 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "title must be a string up to 200 characters"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
	defer cancel()
	upID, err := s.upstream.CreateSession(ctx, owner, input.Title)
	if err != nil {
		if e, ok := asUpstreamError(err); ok && e.Status >= 400 && e.Status < 500 && !e.Uncertain {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Upstream rejected session"})
		} else {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "C1 worker unavailable"})
		}
		return
	}
	localID := newID()
	session, err := s.store.CreateSession(r.Context(), owner, localID, upID, input.Title)
	if err != nil {
		s.internalError(w)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": session.ID, "title": session.Title, "created": session.Created})
}

func (s *Service) sessionRoute(w http.ResponseWriter, r *http.Request, owner, path string) {
	if strings.HasSuffix(path, "/run-lookup") && r.Method == http.MethodGet {
		localSession := strings.TrimSuffix(strings.TrimPrefix(path, "/v1/sessions/"), "/run-lookup")
		if localSession == "" || strings.Contains(localSession, "/") {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "Session not found"})
			return
		}
		if _, err := s.store.Session(r.Context(), owner, localSession); err != nil {
			s.notFound(w, err, "Session not found")
			return
		}
		q := r.URL.Query()
		key := q.Get("key")
		if key == "" || len(key) > 128 || len(q) != 1 || len(q["key"]) != 1 || !validKey(key) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "A single idempotency key is required"})
			return
		}
		run, err := s.store.FindByKey(r.Context(), owner, localSession, key)
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{"found": false, "run": nil})
			return
		}
		if err != nil {
			s.internalError(w)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"found": true, "run": s.publicRun(run)})
		return
	}
	if r.Method == http.MethodPost && strings.HasSuffix(path, "/runs") {
		localSession := strings.TrimSuffix(strings.TrimPrefix(path, "/v1/sessions/"), "/runs")
		if localSession == "" || strings.Contains(localSession, "/") {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "Session not found"})
			return
		}
		session, err := s.store.Session(r.Context(), owner, localSession)
		if err != nil {
			s.notFound(w, err, "Session not found")
			return
		}
		input, err := s.parseRunInput(r)
		if err != nil {
			s.clientError(w, err)
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if !validKey(key) || len(key) > 128 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Idempotency-Key required"})
			return
		}
		run, replayed, err := s.store.CreateRun(r.Context(), RunInput{Owner: owner, SessionID: localSession, Key: key, Request: input.raw, DeadlineMS: 0}, s.cfg.MaxQueued, s.cfg.MaxQueuedPerOwner)
		if errors.Is(err, ErrConflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Idempotency key was used with a different request"})
			return
		}
		if errors.Is(err, ErrQueueFull) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Run queue is full"})
			return
		}
		if err != nil {
			s.internalError(w)
			return
		}
		_ = session
		status := http.StatusAccepted
		if replayed {
			status = http.StatusOK
		}
		writeJSON(w, status, map[string]any{"run": s.publicRun(run), "replayed": replayed})
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "Route not found"})
}

type normalizedRunInput struct {
	raw    json.RawMessage
	budget RunBudget
}
type RunBudget struct {
	MaxTokens          int `json:"maxTokens"`
	MaxToolCalls       int `json:"maxToolCalls"`
	MaxDurationMS      int `json:"maxDurationMs"`
	MaxActiveChildren  int `json:"maxActiveChildren"`
	MaxDelegationDepth int `json:"maxDelegationDepth"`
}

func (s *Service) parseRunInput(r *http.Request) (normalizedRunInput, error) {
	body, err := s.readBody(r)
	if err != nil {
		return normalizedRunInput{}, err
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return normalizedRunInput{}, clientErr{status: 400, msg: "Expected a JSON object"}
	}
	var prompt, mode, memoryStrategy, memoryQuery string
	if json.Unmarshal(fields["prompt"], &prompt) != nil || strings.TrimSpace(prompt) == "" || len([]rune(prompt)) > 40000 {
		return normalizedRunInput{}, clientErr{status: 400, msg: "Nonempty prompt up to 40000 characters required"}
	}
	if fields["mode"] != nil {
		if json.Unmarshal(fields["mode"], &mode) != nil {
			return normalizedRunInput{}, clientErr{status: 400, msg: "mode must be single or multi"}
		}
	}
	if mode == "" {
		mode = "single"
	}
	if mode != "single" && mode != "multi" {
		return normalizedRunInput{}, clientErr{status: 400, msg: "mode must be single or multi"}
	}
	if fields["memoryStrategy"] != nil {
		if json.Unmarshal(fields["memoryStrategy"], &memoryStrategy) != nil {
			return normalizedRunInput{}, clientErr{status: 400, msg: "Invalid memoryStrategy"}
		}
	}
	if memoryStrategy == "" {
		memoryStrategy = "full_history"
	}
	switch memoryStrategy {
	case "full_history", "summary", "retrieval", "none":
	default:
		return normalizedRunInput{}, clientErr{status: 400, msg: "Invalid memoryStrategy"}
	}
	if fields["memoryQuery"] != nil {
		if json.Unmarshal(fields["memoryQuery"], &memoryQuery) != nil || len([]rune(memoryQuery)) > 1000 {
			return normalizedRunInput{}, clientErr{status: 400, msg: "memoryQuery must be a string up to 1000 characters"}
		}
	}
	budget := RunBudget{MaxTokens: 16384, MaxToolCalls: 12, MaxDurationMS: 120000, MaxActiveChildren: 3, MaxDelegationDepth: 1}
	if fields["budget"] != nil {
		var values map[string]json.RawMessage
		if json.Unmarshal(fields["budget"], &values) != nil || values == nil {
			return normalizedRunInput{}, clientErr{status: 400, msg: "Invalid budget"}
		}
		for key, dst := range map[string]*int{"maxTokens": &budget.MaxTokens, "maxToolCalls": &budget.MaxToolCalls, "maxDurationMs": &budget.MaxDurationMS, "maxActiveChildren": &budget.MaxActiveChildren} {
			if raw := values[key]; len(raw) > 0 {
				if json.Unmarshal(raw, dst) != nil {
					return normalizedRunInput{}, clientErr{status: 400, msg: "Invalid budget"}
				}
			}
		}
	}
	if budget.MaxTokens < 1 || budget.MaxTokens > 100000 || budget.MaxToolCalls < 1 || budget.MaxToolCalls > 100 || budget.MaxDurationMS < 1 || budget.MaxDurationMS > 600000 || budget.MaxActiveChildren < 1 || budget.MaxActiveChildren > 8 {
		return normalizedRunInput{}, clientErr{status: 400, msg: "Budget exceeds service limits"}
	}
	canonical := map[string]any{"prompt": strings.TrimSpace(prompt), "mode": mode, "memoryStrategy": memoryStrategy, "budget": budget}
	if strings.TrimSpace(memoryQuery) != "" {
		canonical["memoryQuery"] = strings.TrimSpace(memoryQuery)
	}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return normalizedRunInput{}, clientErr{status: 400, msg: "Invalid request"}
	}
	return normalizedRunInput{raw: raw, budget: budget}, nil
}

func (s *Service) runRoute(w http.ResponseWriter, r *http.Request, owner, path string) {
	rest := strings.TrimPrefix(path, "/v1/runs/")
	parts := strings.Split(rest, "/")
	if len(parts) < 1 || parts[0] == "" || strings.Contains(parts[0], "/") {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Run not found"})
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Run not found"})
		return
	}
	run, err := s.store.Run(r.Context(), owner, id)
	if err != nil {
		s.notFound(w, err, "Run not found")
		return
	}
	action := ""
	if len(parts) > 1 {
		if len(parts) != 2 {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "Route not found"})
			return
		}
		action = parts[1]
	}
	switch {
	case action == "" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, s.publicRun(run))
	case action == "events" && r.Method == http.MethodGet:
		s.events(w, r, owner, run)
	case action == "cancel" && r.Method == http.MethodPost:
		s.cancel(w, r, owner, run)
	case action == "reconcile" && r.Method == http.MethodPost:
		s.reconcile(w, r, owner, run)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Route not found"})
	}
}

func (s *Service) publicRun(run Run) map[string]any {
	var request, result, errorValue any
	_ = json.Unmarshal(run.Request, &request)
	if len(run.Result) > 0 {
		_ = json.Unmarshal(run.Result, &result)
	}
	if len(run.Error) > 0 {
		_ = json.Unmarshal(run.Error, &errorValue)
	}
	value := map[string]any{"id": run.ID, "session_id": run.SessionID, "status": run.Status, "request": request, "result": result, "created": run.Created, "updated": run.Updated}
	if errorValue != nil {
		value["error"] = errorValue
	}
	return value
}

func (s *Service) cancel(w http.ResponseWriter, r *http.Request, owner string, run Run) {
	if run.Status == "queued" {
		result, cancelled, err := s.store.CancelQueued(r.Context(), owner, run.ID)
		if err != nil {
			s.internalError(w)
			return
		}
		if cancelled {
			writeJSON(w, http.StatusOK, map[string]any{"status": result.Status})
			return
		}
		run = result
	}
	if terminal(run.Status) {
		writeJSON(w, http.StatusOK, map[string]any{"status": run.Status})
		return
	}
	result, err := s.store.RequestCancel(r.Context(), owner, run.ID)
	if err != nil {
		s.internalError(w)
		return
	}
	if result.Status == "unknown" || terminal(result.Status) {
		writeJSON(w, http.StatusOK, map[string]any{"status": result.Status})
		return
	}
	if result.UpstreamID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
		defer cancel()
		if err := s.upstream.CancelRun(ctx, owner, result.UpstreamID); err != nil && result.Status != "cancelling" {
			writeJSON(w, http.StatusBadGateway, map[string]any{"status": "cancelling"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "cancelling"})
}

func (s *Service) reconcile(w http.ResponseWriter, r *http.Request, owner string, run Run) {
	if run.Status != "unknown" {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Only an unknown run can be reconciled"})
		return
	}
	run, err := s.store.BeginReconcile(r.Context(), owner, run.ID)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Run is already being reconciled"})
			return
		}
		s.internalError(w)
		return
	}
	session, err := s.store.Session(r.Context(), owner, run.SessionID)
	if err != nil {
		s.notFound(w, err, "Session not found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
	defer cancel()
	remote, found, err := s.upstream.LookupRun(ctx, owner, session.UpstreamID, run.Key)
	if err != nil {
		_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", "", nil, map[string]string{"code": "LOOKUP_OUTCOME_UNKNOWN"}, nil, "run.unknown", map[string]string{"reason": "reconcile_lookup_unavailable"}, run.ClaimToken)
		writeJSON(w, http.StatusBadGateway, map[string]any{"status": "unknown", "error": "C1 reconciliation unavailable"})
		return
	}
	strategy := "lookup_found"
	if !found {
		if run.CancelRequested {
			cancelled, err := s.store.ChangeClaim(r.Context(), owner, run.ID, "cancelled", "", nil, nil, nil, "run.cancelled", map[string]string{"reason": "cancelled_before_upstream_start"}, run.ClaimToken)
			if err != nil {
				s.internalError(w)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"run": s.publicRun(cancelled), "reconciled": true})
			return
		}
		strategy = "same_key_restarted"
		budget := requestBudget(run.Request)
		if _, err := s.store.SetDeadlineClaim(r.Context(), owner, run.ID, time.Now().Add(time.Duration(budget.MaxDurationMS)*time.Millisecond).UnixMilli(), run.ClaimToken); err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Run reconciliation claim is stale"})
			return
		}
		allowed, current, dispatchErr := s.store.BeginDispatch(r.Context(), owner, run.ID, run.ClaimToken)
		if dispatchErr != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Run reconciliation claim is stale"})
			return
		}
		if !allowed {
			writeJSON(w, http.StatusOK, map[string]any{"run": s.publicRun(current), "reconciled": true})
			return
		}
		remote, err = s.upstream.StartRun(ctx, owner, session.UpstreamID, run.Key, run.Request)
		if err != nil {
			if e, ok := asUpstreamError(err); ok && !e.Uncertain {
				failed, _ := s.store.ChangeClaim(r.Context(), owner, run.ID, "failed", "", nil, map[string]string{"code": "UPSTREAM_REJECTED"}, nil, "run.failed", map[string]string{"code": "UPSTREAM_REJECTED"}, run.ClaimToken)
				writeJSON(w, http.StatusBadGateway, map[string]any{"run": s.publicRun(failed), "reconciled": false})
				return
			}
			_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", "", nil, map[string]string{"code": "START_OUTCOME_UNKNOWN"}, nil, "run.unknown", map[string]string{"reason": "reconcile_start_ambiguous"}, run.ClaimToken)
			writeJSON(w, http.StatusBadGateway, map[string]any{"status": "unknown", "error": "C1 start outcome remains unknown"})
			return
		}
	}
	upID := stringValue(remote["id"])
	if upID == "" {
		_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", "", nil, map[string]string{"code": "LOOKUP_RESPONSE_INVALID"}, nil, "run.unknown", map[string]string{"reason": "reconcile_response_invalid"}, run.ClaimToken)
		writeJSON(w, http.StatusBadGateway, map[string]any{"status": "unknown", "error": "C1 returned an invalid run"})
		return
	}
	updated, err := s.store.ChangeClaim(r.Context(), owner, run.ID, "queued", upID, nil, nil, nil, "run.reconciled", map[string]string{"strategy": strategy}, run.ClaimToken)
	if err != nil {
		s.internalError(w)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"run": s.publicRun(updated), "reconciled": true})
}

func (s *Service) events(w http.ResponseWriter, r *http.Request, owner string, run Run) {
	after := int64(0)
	if value := r.Header.Get("Last-Event-ID"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid event cursor"})
			return
		}
		after = parsed
	} else if value := r.URL.Query().Get("after"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid event cursor"})
			return
		}
		after = parsed
	}
	if len(r.URL.Query()) > 1 || len(r.URL.Query()["after"]) > 1 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid event cursor"})
		return
	}
	events, err := s.store.Events(r.Context(), owner, run.ID, after, 1000)
	if err != nil {
		s.internalError(w)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	for _, event := range events {
		value := map[string]any{"id": event.ID, "runId": event.RunID, "type": event.Type, "created": event.Created}
		var payload any
		if json.Unmarshal(event.Payload, &payload) == nil {
			value["payload"] = payload
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			continue
		}
		_, _ = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, encoded)
	}
}

func (s *Service) worker(ctx context.Context) {
	defer s.workers.Done()
	for {
		if ctx.Err() != nil {
			return
		}
		run, err := s.store.Claim(ctx, s.cfg.MaxActivePerOwner)
		if err == nil {
			s.runsStarted.Add(1)
			s.execute(ctx, run)
			continue
		}
		if !errors.Is(err, ErrNotFound) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *Service) execute(ctx context.Context, claimed Run) {
	owner := claimed.Owner
	run, err := s.store.Run(ctx, owner, claimed.ID)
	if err != nil {
		return
	}
	session, err := s.store.Session(ctx, owner, run.SessionID)
	if err != nil {
		_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "failed", "", nil, map[string]string{"code": "SESSION_MISSING"}, nil, "run.failed", map[string]string{"code": "SESSION_MISSING"}, run.ClaimToken)
		return
	}
	upID := run.UpstreamID
	if upID == "" {
		budget := requestBudget(run.Request)
		run, err = s.store.SetDeadlineClaim(ctx, owner, run.ID, time.Now().Add(time.Duration(budget.MaxDurationMS)*time.Millisecond).UnixMilli(), run.ClaimToken)
		if err != nil {
			return
		}
		allowed, current, dispatchErr := s.store.BeginDispatch(ctx, owner, run.ID, run.ClaimToken)
		if dispatchErr != nil || !allowed {
			return
		}
		run = current
		startCtx, cancel := context.WithTimeout(ctx, time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
		remote, startErr := s.upstream.StartRun(startCtx, owner, session.UpstreamID, run.Key, run.Request)
		cancel()
		if startErr != nil {
			if e, ok := asUpstreamError(startErr); ok && !e.Uncertain {
				_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "failed", "", nil, map[string]string{"code": "UPSTREAM_REJECTED"}, nil, "run.failed", map[string]string{"code": "UPSTREAM_REJECTED"}, run.ClaimToken)
				return
			}
			_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", "", nil, map[string]string{"code": "START_OUTCOME_UNKNOWN"}, nil, "run.unknown", map[string]string{"reason": "upstream_start_ambiguous"}, run.ClaimToken)
			return
		}
		upID = stringValue(remote["id"])
		if upID == "" {
			_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", "", nil, map[string]string{"code": "START_RESPONSE_INVALID"}, nil, "run.unknown", map[string]string{"reason": "upstream_start_response_invalid"}, run.ClaimToken)
			return
		}
		if _, err = s.store.ChangeClaim(ctx, owner, run.ID, "running", upID, nil, nil, nil, "run.running", map[string]any{}, run.ClaimToken); err != nil {
			return
		}
	} else {
		if _, err = s.store.ChangeClaim(ctx, owner, run.ID, "running", upID, nil, nil, nil, "run.resumed", map[string]any{}, run.ClaimToken); err != nil {
			return
		}
	}
	snapshot, _ := s.store.Run(ctx, owner, run.ID)
	if snapshot.CancelRequested {
		cancelCtx, cancel := context.WithTimeout(ctx, time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
		_ = s.upstream.CancelRun(cancelCtx, owner, upID)
		cancel()
	}
	cursor := snapshot.UpstreamCursor
	poll := time.Duration(s.cfg.PollIntervalMS) * time.Millisecond
	for ctx.Err() == nil {
		eventCtx, eventCancel := context.WithTimeout(ctx, 250*time.Millisecond)
		events, eventErr := s.upstream.Events(eventCtx, owner, upID, cursor)
		eventCancel()
		forwardFailed := false
		if eventErr == nil {
			for _, ev := range events {
				payload := map[string]any{"upstreamEventId": ev.ID}
				if p, ok := ev.Data["payload"]; ok {
					payload["source"] = p
				}
				if err = s.store.ForwardEventClaim(ctx, owner, run.ID, ev.ID, ev.Type, payload, run.ClaimToken); err == nil {
					cursor = ev.ID
				} else {
					forwardFailed = true
					break
				}
			}
		}
		if forwardFailed {
			select {
			case <-ctx.Done():
				return
			case <-time.After(poll):
			}
			continue
		}
		getCtx, getCancel := context.WithTimeout(ctx, time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
		remote, getErr := s.upstream.GetRun(getCtx, owner, upID)
		getCancel()
		if getErr == nil {
			status := stringValue(remote["status"])
			if terminal(status) {
				result := remote["result"]
				if status == "failed" || status == "timed_out" {
					_, err = s.store.ChangeClaim(ctx, owner, run.ID, status, upID, result, remote["error"], nil, "run."+status, map[string]any{"upstreamStatus": status}, run.ClaimToken)
				} else {
					_, err = s.store.ChangeClaim(ctx, owner, run.ID, status, upID, result, nil, nil, "run."+status, map[string]any{"upstreamStatus": status}, run.ClaimToken)
				}
				if err == nil {
					s.completed.Add(1)
				}
				return
			}
			if status == "unknown" {
				_, _ = s.store.ChangeClaim(ctx, owner, run.ID, "unknown", upID, nil, map[string]string{"code": "UPSTREAM_STATUS_UNKNOWN"}, nil, "run.unknown", map[string]string{"reason": "worker_run_status_unknown"}, run.ClaimToken)
				return
			}
		}
		if time.Now().UnixMilli() >= run.DeadlineMS {
			cancelCtx, cancel := context.WithTimeout(ctx, time.Duration(s.cfg.UpstreamTimeoutMS)*time.Millisecond)
			cancelErr := s.upstream.CancelRun(cancelCtx, owner, upID)
			cancel()
			if cancelErr != nil {
				_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", upID, nil, map[string]string{"code": "CANCEL_OUTCOME_UNKNOWN"}, nil, "run.unknown", map[string]string{"reason": "deadline_cancel_ambiguous"}, run.ClaimToken)
				return
			}
			_, _ = s.store.ChangeClaim(context.Background(), owner, run.ID, "unknown", upID, nil, map[string]string{"code": "UPSTREAM_DID_NOT_FINISH_WITHIN_BUDGET"}, nil, "run.unknown", map[string]string{"reason": "upstream_run_not_terminal_at_deadline"}, run.ClaimToken)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(poll):
		}
	}
}

func requestBudget(request json.RawMessage) RunBudget {
	var value struct {
		Budget RunBudget `json:"budget"`
	}
	_ = json.Unmarshal(request, &value)
	if value.Budget.MaxDurationMS < 1 {
		value.Budget.MaxDurationMS = 120_000
	}
	return value.Budget
}

func (s *Service) readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, clientErr{status: 400, msg: "Expected a JSON object"}
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, s.cfg.MaxBodyBytes+1))
	if err != nil {
		return nil, clientErr{status: 400, msg: "Expected a JSON object"}
	}
	if int64(len(data)) > s.cfg.MaxBodyBytes {
		return nil, clientErr{status: 413, msg: "Request too large"}
	}
	return data, nil
}

type clientErr struct {
	status int
	msg    string
}

func (e clientErr) Error() string { return e.msg }
func (s *Service) clientError(w http.ResponseWriter, err error) {
	var e clientErr
	if errors.As(err, &e) {
		writeJSON(w, e.status, map[string]any{"error": e.msg})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
}
func (s *Service) internalError(w http.ResponseWriter) {
	s.errors.Add(1)
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal service error"})
}
func (s *Service) notFound(w http.ResponseWriter, err error, message string) {
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": message})
		return
	}
	s.internalError(w)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func validKey(key string) bool {
	if key == "" || len(key) > 128 {
		return false
	}
	for _, r := range key {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}
func terminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "timed_out", "partial":
		return true
	}
	return false
}
func asUpstreamError(err error) (*UpstreamError, bool) {
	var value *UpstreamError
	ok := errors.As(err, &value)
	return value, ok
}

var _ = fmt.Sprintf
