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
	"strings"
	"time"

	"apitunnel/apipsub/internal/config"
	"apitunnel/apipsub/internal/sseclient"
	"apitunnel/apipsub/internal/subenv"
)

const helpMsg = `
Usage:
  export PUB_URL=http://pub:5001/sub/<entry>
  export SUB_CONFIG=/path/to/config.json
  apitunnel-sub

config.json example:
  {
    "tunnel": {
      "http": {
        "cowk": { "url": "http://&<region>.local/&<remain>" }
      }
    }
  }`

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
	for {
		if err := s.run(); err != nil {
			log.Printf("[I] %s disconnected: %v", ts(), err)
		} else {
			log.Printf("[I] %s disconnected", ts())
		}
		time.Sleep(10 * time.Second)
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

// run connects to the pub and dispatches tasks until the stream ends.
func (s *Sub) run() error {
	log.Printf(`[I] %s connecting to %q ...`, ts(), s.pubURL)
	stream, err := sseclient.Dial(context.Background(), s.pubURL, s.cfg.Token, s.cfg.LB, s.cfg.LBN)
	if err != nil {
		return err
	}
	defer stream.Close()
	log.Printf("[I] %s connected", ts())
	for {
		msg, err, ok := stream.Read()
		if !ok {
			return nil
		}
		if err != nil {
			return err
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
