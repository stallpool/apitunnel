// Command sub runs the apitunnel sub (Go port of sub/index.js).
//
// It connects to the pub over SSE (GET /sub/<entry>) and bridges client http
// requests to the backends configured in config.json. Responses are posted
// back to the pub (POST /sub/<entry>). No websocket is used.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"apitunnel/apipsub/internal/config"
	"apitunnel/apipsub/internal/sseclient"
	"apitunnel/apipsub/internal/subenv"
)

// retryLogger writes connection-level logs to stdout so reconnection attempts
// are visible alongside access traces.
var retryLogger = log.New(os.Stdout, "", 0)

// backoff computes the retry delay with exponential backoff:
// 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, 1024s, 2048s, 3600s (capped).
func backoff(attempt int) time.Duration {
	const (
		base    = 2
		capSecs = 3600
	)
	if attempt < 0 {
		attempt = 0
	}
	if attempt >= 11 {
		// 2^(attempt+1) already exceeds the cap here; the early return also
		// keeps the shift from overflowing to 0 for huge attempt counts.
		return capSecs * time.Second
	}
	d := base << attempt // 2^(attempt+1) via shift
	if d > capSecs {
		d = capSecs
	}
	return time.Duration(d) * time.Second
}

const helpMsg = `
Usage:
  export PUB_URL=http://pub:5001/sub/<entry>
  export SUB_CONFIG=/path/to/config.json
  apitunnel-sub

config.json example:
  {
    "tunnel": {
      "http": {
        "cowk": {
          "url": "http://&<region>.local/&<remain>",
          "include": ["^/api/"],
          "exclude": ["^/api/admin/"]
        }
      }
    }
  }

  include/exclude are optional lists of regexes matched against the request
  path ("/" + remain). With include, only matching paths are bridged; with
  exclude, matching paths are rejected. Rejected requests get 404.`

// Sub is a subscriber: it keeps an SSE stream to the pub and bridges http
// requests to the configured backends.
type Sub struct {
	cfg    subenv.Config
	config *config.Config
	pubURL string
	client *http.Client
}

func main() {
	cfg := subenv.Load()
	if cfg.PubURL == "" {
		log.Fatal("PUB_URL is required. " + helpMsg)
	}
	if cfg.ConfigPath == "" {
		log.Fatal("SUB_CONFIG is required. " + helpMsg)
	}
	c := config.New(cfg.ConfigPath)
	c.StartWatch()
	s := &Sub{
		cfg:    cfg,
		config: c,
		pubURL: normalizePubURL(cfg.PubURL),
		client: &http.Client{},
	}
	if cfg.LB != "" {
		log.Printf(`[I] %s loadbalancer: %s (%d)`, ts(), cfg.LB, cfg.LBN)
	}
	// watchdog: (re)connect until the process is stopped.
	attempt := 0
	for {
		connected, err := s.run()
		if err != nil {
			retryLogger.Printf("[I] %s disconnected: %v", ts(), err)
		} else {
			retryLogger.Printf("[I] %s disconnected", ts())
		}
		if connected {
			// The connection did succeed, so the next drop must not inherit
			// the old backoff: start over at 2s.
			attempt = 0
		}
		delay := backoff(attempt)
		attempt++
		retryLogger.Printf("[I] %s reconnect in %s", ts(), delay)
		time.Sleep(delay)
	}
}

// normalizePubURL rewrites a legacy ws(s):// pub url to http(s):// so the
// same PUB_URL value works for both the old ws sub and this SSE sub.
func normalizePubURL(u string) string {
	switch {
	case strings.HasPrefix(u, "wss://"):
		return "https://" + strings.TrimPrefix(u, "wss://")
	case strings.HasPrefix(u, "ws://"):
		return "http://" + strings.TrimPrefix(u, "ws://")
	}
	return u
}

// run connects to the pub and dispatches tasks until the stream ends. It
// also reports whether the connection was established at least once, which
// the watchdog uses to reset the reconnect backoff.
func (s *Sub) run() (bool, error) {
	log.Printf(`[I] %s connecting to %q ...`, ts(), s.pubURL)
	stream, err := sseclient.Dial(context.Background(), s.pubURL, s.cfg.Token, s.cfg.LB, s.cfg.LBN)
	if err != nil {
		return false, err
	}
	defer stream.Close()
	log.Printf("[I] %s connected", ts())
	for {
		msg, err, ok := stream.Read()
		if !ok {
			return true, nil
		}
		if err != nil {
			return true, err
		}
		s.dispatch(msg)
	}
}

// dispatch handles one bridged request task. Each request is independent, so
// they run concurrently (like the JS sub).
func (s *Sub) dispatch(payload string) {
	var m httpReq
	if json.Unmarshal([]byte(payload), &m) != nil {
		return
	}
	go s.handleHttp(m)
}

func ts() string {
	return time.Now().UTC().Format(time.RFC3339)
}
