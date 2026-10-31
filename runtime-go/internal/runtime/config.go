package runtime

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Listen            string            `json:"listen"`
	Database          string            `json:"database"`
	C1BaseURL         string            `json:"c1_base_url"`
	AuthTokens        map[string]string `json:"auth_tokens"`
	WorkerTokens      map[string]string `json:"worker_tokens"`
	Workers           int               `json:"workers"`
	MaxQueued         int               `json:"max_queued"`
	MaxQueuedPerOwner int               `json:"max_queued_per_owner"`
	MaxActivePerOwner int               `json:"max_active_per_owner"`
	MaxBodyBytes      int64             `json:"max_body_bytes"`
	PollIntervalMS    int               `json:"poll_interval_ms"`
	UpstreamTimeoutMS int               `json:"upstream_timeout_ms"`
}

func LoadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	if cfg.Database != ":memory:" && !filepath.IsAbs(cfg.Database) {
		cfg.Database = filepath.Clean(filepath.Join(filepath.Dir(path), cfg.Database))
	}
	return cfg, nil
}

func (c *Config) Validate() error {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8787"
	}
	if c.Database == "" {
		c.Database = "./data/runtime.sqlite"
	}
	if c.C1BaseURL == "" {
		return errors.New("c1_base_url is required")
	}
	u, err := url.Parse(c.C1BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return errors.New("c1_base_url must be an HTTP(S) origin without credentials, path, query, or fragment")
	}
	c.C1BaseURL = strings.TrimRight(c.C1BaseURL, "/")
	if len(c.AuthTokens) == 0 || len(c.WorkerTokens) == 0 {
		return errors.New("auth_tokens and worker_tokens are required")
	}
	for token, owner := range c.AuthTokens {
		if strings.TrimSpace(token) == "" || len(token) > 4096 || strings.TrimSpace(owner) == "" || len(owner) > 200 {
			return errors.New("invalid auth_tokens entry")
		}
		if _, ok := c.WorkerTokens[owner]; !ok {
			return fmt.Errorf("worker token is not configured for owner %q", owner)
		}
	}
	for owner, token := range c.WorkerTokens {
		if strings.TrimSpace(owner) == "" || strings.TrimSpace(token) == "" || len(token) > 4096 {
			return errors.New("invalid worker_tokens entry")
		}
	}
	if c.Workers == 0 {
		c.Workers = 4
	}
	if c.Workers < 1 || c.Workers > 128 {
		return errors.New("workers must be from 1 through 128")
	}
	if c.MaxQueued == 0 {
		c.MaxQueued = 100
	}
	if c.MaxQueued < 1 || c.MaxQueued > 10000 {
		return errors.New("max_queued must be from 1 through 10000")
	}
	if c.MaxQueuedPerOwner == 0 {
		c.MaxQueuedPerOwner = 20
	}
	if c.MaxQueuedPerOwner < 1 || c.MaxQueuedPerOwner > c.MaxQueued {
		return errors.New("max_queued_per_owner must be positive and no larger than max_queued")
	}
	if c.MaxActivePerOwner == 0 {
		c.MaxActivePerOwner = 2
	}
	if c.MaxActivePerOwner < 1 || c.MaxActivePerOwner > c.Workers {
		return errors.New("max_active_per_owner must be positive and no larger than workers")
	}
	if c.MaxBodyBytes == 0 {
		c.MaxBodyBytes = 128_000
	}
	if c.MaxBodyBytes < 1024 || c.MaxBodyBytes > 1_000_000 {
		return errors.New("max_body_bytes must be from 1024 through 1000000")
	}
	if c.PollIntervalMS == 0 {
		c.PollIntervalMS = 500
	}
	if c.PollIntervalMS < 50 || c.PollIntervalMS > 5000 {
		return errors.New("poll_interval_ms must be from 50 through 5000")
	}
	if c.UpstreamTimeoutMS == 0 {
		c.UpstreamTimeoutMS = 5000
	}
	if c.UpstreamTimeoutMS < 100 || c.UpstreamTimeoutMS > 120_000 {
		return errors.New("upstream_timeout_ms must be from 100 through 120000")
	}
	return nil
}

type tokenOwner struct {
	digest [32]byte
	owner  string
}

func tokenEntries(values map[string]string) []tokenOwner {
	entries := make([]tokenOwner, 0, len(values))
	for token, owner := range values {
		entries = append(entries, tokenOwner{digest: sha256.Sum256([]byte(token)), owner: owner})
	}
	return entries
}

func ownerForBearer(header string, entries []tokenOwner) (string, bool) {
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(header, "Bearer ")
	if token == "" || len(token) > 4096 {
		return "", false
	}
	digest := sha256.Sum256([]byte(token))
	for _, entry := range entries {
		if subtle.ConstantTimeCompare(digest[:], entry.digest[:]) == 1 {
			return entry.owner, true
		}
	}
	return "", false
}
