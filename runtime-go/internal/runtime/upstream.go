package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const upstreamMaxBytes = 4 << 20

type UpstreamError struct {
	Status    int
	Uncertain bool
	Code      string
}

func (e *UpstreamError) Error() string { return e.Code }

type C1Client struct {
	base    string
	tokens  map[string]string
	http    *http.Client
	timeout time.Duration
}

func NewC1Client(base string, tokens map[string]string, timeout time.Duration) *C1Client {
	return &C1Client{base: strings.TrimRight(base, "/"), tokens: tokens, http: &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, timeout: timeout}
}

func (c *C1Client) request(ctx context.Context, owner, method, path string, body []byte, key string, mutating bool) (int, []byte, error) {
	token, ok := c.tokens[owner]
	if !ok || token == "" {
		return 0, nil, &UpstreamError{Code: "worker_auth_missing"}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, &UpstreamError{Code: "upstream_request_invalid"}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, &UpstreamError{Uncertain: mutating, Code: "upstream_transport"}
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, upstreamMaxBytes+1))
	if readErr != nil {
		return resp.StatusCode, nil, &UpstreamError{Status: resp.StatusCode, Uncertain: mutating, Code: "upstream_read"}
	}
	if len(data) > upstreamMaxBytes {
		return resp.StatusCode, nil, &UpstreamError{Status: resp.StatusCode, Uncertain: mutating, Code: "upstream_response_limit"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		uncertain := mutating && !(resp.StatusCode >= 400 && resp.StatusCode < 500)
		return resp.StatusCode, data, &UpstreamError{Status: resp.StatusCode, Uncertain: uncertain, Code: "upstream_http_error"}
	}
	return resp.StatusCode, data, nil
}

func (c *C1Client) CreateSession(ctx context.Context, owner, title string) (string, error) {
	body, _ := json.Marshal(map[string]string{"title": title})
	status, data, err := c.request(ctx, owner, http.MethodPost, "/v1/sessions", body, "", true)
	if err != nil {
		return "", err
	}
	if status != http.StatusCreated {
		return "", &UpstreamError{Status: status, Uncertain: true, Code: "upstream_session_response"}
	}
	var value struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &value) != nil || value.ID == "" {
		return "", &UpstreamError{Status: status, Uncertain: true, Code: "upstream_session_response"}
	}
	return value.ID, nil
}

func (c *C1Client) StartRun(ctx context.Context, owner, sessionID, key string, request json.RawMessage) (map[string]any, error) {
	status, data, err := c.request(ctx, owner, http.MethodPost, "/v1/sessions/"+url.PathEscape(sessionID)+"/runs", request, key, true)
	if err != nil {
		return nil, err
	}
	if status != http.StatusAccepted && status != http.StatusOK {
		return nil, &UpstreamError{Status: status, Uncertain: true, Code: "upstream_start_response"}
	}
	var value struct {
		Run      map[string]any `json:"run"`
		Replayed *bool          `json:"replayed"`
	}
	if json.Unmarshal(data, &value) != nil || value.Run == nil || value.Replayed == nil || stringValue(value.Run["id"]) == "" {
		return nil, &UpstreamError{Status: status, Uncertain: true, Code: "upstream_start_response"}
	}
	return value.Run, nil
}

func (c *C1Client) LookupRun(ctx context.Context, owner, sessionID, key string) (map[string]any, bool, error) {
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/run-lookup?key=" + url.QueryEscape(key)
	_, data, err := c.request(ctx, owner, http.MethodGet, path, nil, "", false)
	if err != nil {
		return nil, false, err
	}
	var value struct {
		Found bool           `json:"found"`
		Run   map[string]any `json:"run"`
	}
	if json.Unmarshal(data, &value) != nil || value.Found && value.Run == nil {
		return nil, false, &UpstreamError{Code: "upstream_lookup_response"}
	}
	return value.Run, value.Found, nil
}

func (c *C1Client) GetRun(ctx context.Context, owner, runID string) (map[string]any, error) {
	_, data, err := c.request(ctx, owner, http.MethodGet, "/v1/runs/"+url.PathEscape(runID), nil, "", false)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil || value["id"] != runID {
		return nil, &UpstreamError{Code: "upstream_run_response"}
	}
	return value, nil
}

func (c *C1Client) CancelRun(ctx context.Context, owner, runID string) error {
	_, _, err := c.request(ctx, owner, http.MethodPost, "/v1/runs/"+url.PathEscape(runID)+"/cancel", []byte(`{}`), "", true)
	return err
}

type UpstreamEvent struct {
	ID   int64
	Type string
	Data map[string]any
}

func (c *C1Client) Events(ctx context.Context, owner, runID string, after int64) ([]UpstreamEvent, error) {
	token, ok := c.tokens[owner]
	if !ok {
		return nil, &UpstreamError{Code: "worker_auth_missing"}
	}
	readCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(readCtx, http.MethodGet, c.base+"/v1/runs/"+url.PathEscape(runID)+"/events?after="+strconv.FormatInt(after, 10), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(readCtx.Err(), context.DeadlineExceeded) {
			return nil, nil
		}
		return nil, &UpstreamError{Code: "upstream_events_transport"}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &UpstreamError{Status: resp.StatusCode, Code: "upstream_events_http"}
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil && !errors.Is(readErr, context.DeadlineExceeded) && !errors.Is(readCtx.Err(), context.DeadlineExceeded) {
		return nil, &UpstreamError{Code: "upstream_events_read"}
	}
	return parseSSE(data, after)
}

func parseSSE(data []byte, after int64) ([]UpstreamEvent, error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	blocks := strings.Split(text, "\n\n")
	out := make([]UpstreamEvent, 0)
	for _, block := range blocks {
		var eventID int64 = -1
		eventName := ""
		dataLines := []string{}
		for _, line := range strings.Split(block, "\n") {
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}
			field, value, _ := strings.Cut(line, ":")
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "id":
				eventID, _ = strconv.ParseInt(value, 10, 64)
			case "event":
				eventName = value
			case "data":
				dataLines = append(dataLines, value)
			}
		}
		if len(dataLines) == 0 {
			continue
		}
		var value map[string]any
		if json.Unmarshal([]byte(strings.Join(dataLines, "\n")), &value) != nil {
			return nil, fmt.Errorf("invalid upstream event")
		}
		id, ok := numberAsInt64(value["id"])
		if !ok || eventID < 0 || id != eventID {
			return nil, fmt.Errorf("invalid upstream event id")
		}
		kind, ok := value["type"].(string)
		if !ok || kind == "" || eventName != "" && eventName != kind {
			return nil, fmt.Errorf("invalid upstream event type")
		}
		if id > after {
			out = append(out, UpstreamEvent{ID: id, Type: kind, Data: value})
		}
	}
	return out, nil
}

func numberAsInt64(value any) (int64, bool) {
	switch v := value.(type) {
	case float64:
		if v != float64(int64(v)) {
			return 0, false
		}
		return int64(v), true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	default:
		return 0, false
	}
}
func stringValue(value any) string { v, _ := value.(string); return v }
