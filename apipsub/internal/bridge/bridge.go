// Package bridge implements the pub side of the tunnel.
//
// pub exposes:
//
//	GET  /ping        -> "pong"
//	GET  /sub/<entry> -> SSE stream pushing bridged request tasks to a sub
//	POST /sub/<entry> -> sub posts bridged responses back
//	ANY  /<entry>/... -> bridged to a registered sub
//
// The sub<->pub channel is SSE + HTTP POST; websocket is not used.
package bridge

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"time"

	"apitunnel/apipsub/internal/env"
	"apitunnel/apipsub/internal/lb"
	"apitunnel/apipsub/internal/sse"
)

const (
	// httpMaxID is the request id space, same as the legacy JS pub.
	httpMaxID = 10000000
	// bodyLimit caps the request body that can be bridged (10K).
	bodyLimit = 10 * 1024
	// msgLimit caps sub -> pub message size (10MB).
	msgLimit = 10 * 1024 * 1024
	// taskTTL: bridged requests waiting longer than this get 504.
	taskTTL = 10 * time.Second
)

type task struct {
	ts   time.Time
	res  http.ResponseWriter
	done chan struct{}
}

// reqMsg is pushed to a subscriber for a bridged http request.
type reqMsg struct {
	Type    string            `json:"type"`
	ID      int               `json:"id"`
	Method  string            `json:"method"`
	URI     string            `json:"uri"`
	Data    *string           `json:"data"`
	Headers map[string]string `json:"headers"`
}

// resMsg is posted back by a subscriber with the bridged response.
type resMsg struct {
	Type    string            `json:"type"`
	ID      int               `json:"id"`
	Code    int               `json:"code"`
	Headers map[string]string `json:"headers"`
	Data    string            `json:"data"`
}

// Bridge routes client requests to registered subscribers and back.
type Bridge struct {
	cfg     env.Config
	token   string // hmac hash of cfg.Token; empty disables sub auth
	entries map[string]bool

	mu     sync.Mutex
	lbs    map[string]lb.LoadBalance
	tasks  map[int]*task
	taskc  int
	hid    int
	subs   int // total SSE subscriber connections
	maxSub int // global SSE connection cap from cfg.MaxSubs
}

func New(cfg env.Config) *Bridge {
	b := &Bridge{
		cfg:     cfg,
		entries: map[string]bool{},
		lbs:     map[string]lb.LoadBalance{},
		tasks:   map[int]*task{},
		maxSub:  cfg.MaxSubs,
	}
	for _, e := range cfg.Entries {
		e = strings.TrimSpace(e)
		if e != "" {
			b.entries[e] = true
		}
	}
	if cfg.Token != "" {
		b.token = hash(cfg.Token, cfg.Salt)
	}
	return b
}

// Run starts background maintenance (task garbage collection) and blocks
// until ctx is cancelled.
func (b *Bridge) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			b.gcTasks()
		}
	}
}

// gcTimes out tasks that no sub answered within taskTTL.
func (b *Bridge) gcTasks() {
	now := time.Now()
	b.mu.Lock()
	var out []*task
	for id, t := range b.tasks {
		if now.Sub(t.ts) <= taskTTL {
			continue
		}
		delete(b.tasks, id)
		b.taskc--
		out = append(out, t)
	}
	b.mu.Unlock()
	for _, t := range out {
		t.res.WriteHeader(http.StatusGatewayTimeout)
		close(t.done)
	}
}

// hash is the token check used by both pub and sub:
// hex(HMAC-SHA512(salt, text)).
func hash(text, salt string) string {
	m := hmac.New(sha512.New, []byte(salt))
	m.Write([]byte(text))
	return hex.EncodeToString(m.Sum(nil))
}

// ServeHTTP routes requests; mirrors the legacy JS basicRoute.
func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	seg := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(seg) == 0 || seg[0] == "" {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	switch seg[0] {
	case "ping":
		w.Write([]byte("pong"))
	case "sub":
		if len(seg) < 2 || seg[1] == "" {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		switch r.Method {
		case http.MethodGet:
			b.handleSub(w, r, seg[1])
		case http.MethodPost:
			b.handleSubPost(w, r, seg[1])
		default:
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		}
	default:
		if !b.entries[seg[0]] {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		b.handleAPI(w, r, seg[0])
	}
}

// handleSub accepts a subscriber over SSE.
//
//	Query params:
//	  token  raw pub token (when PUB_TOKEN is set)
//	  lb     "roundrobin" | "idbind"; the first sub decides for the entry
//	  lb_n   max subscribers for the entry's load balancer
func (b *Bridge) handleSub(w http.ResponseWriter, r *http.Request, entry string) {
	if !b.entries[entry] {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	if !b.authOK(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	q := r.URL.Query()
	lbName := q.Get("lb")
	lbN, _ := strconv.Atoi(q.Get("lb_n"))

	b.mu.Lock()
	if b.maxSub > 0 && b.subs >= b.maxSub {
		b.mu.Unlock()
		http.Error(w, "Too Many Subscribers", http.StatusServiceUnavailable)
		return
	}
	if l := b.lbs[entry]; l != nil && !l.HasEmptySlot() {
		b.mu.Unlock()
		http.Error(w, "Too Many Subscribers", http.StatusServiceUnavailable)
		return
	}
	bal := b.lbs[entry]
	if bal == nil {
		// let the first connected sub decide the load balancer type
		bal = lb.Build(lbName, lbN)
	}
	b.mu.Unlock()

	c := sse.NewClient(w, entry, clientIP(r))
	c.Begin(r.Context())

	b.mu.Lock()
	bal.AddConn(c)
	b.lbs[entry] = bal
	b.subs++
	n := bal.CountConn()
	b.mu.Unlock()
	log.Printf(`[I] %q (%d) %s connected`, entry, n, c.IP)

	<-r.Context().Done()
	c.Close()

	b.mu.Lock()
	l := b.lbs[entry]
	var n2 int
	if l != nil {
		l.DelConn(c)
		if !l.HasConn() {
			delete(b.lbs, entry)
		}
		n2 = l.CountConn()
	}
	b.subs--
	b.mu.Unlock()
	if l != nil {
		log.Printf(`[I] %q (%d) %s disconnected`, entry, n2, c.IP)
	}
}

// handleSubPost receives bridged responses from a subscriber.
func (b *Bridge) handleSubPost(w http.ResponseWriter, r *http.Request, entry string) {
	if !b.entries[entry] {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	if !b.authOK(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, msgLimit+1))
	if err != nil || len(body) > msgLimit {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	var m resMsg
	if err := json.Unmarshal(body, &m); err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	if m.Type != "" && m.Type != "res" {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	b.handleHTTPRes(m)
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("{}"))
}

// authOK verifies the subscriber token, when pub token auth is enabled.
// The raw token may come from the X-Pub-Token header or the token query
// param (the latter works with browser EventSource).
// Uses constant-time comparison to prevent timing attacks.
func (b *Bridge) authOK(r *http.Request) bool {
	if b.token == "" {
		return true
	}
	raw := r.Header.Get("X-Pub-Token")
	if raw == "" {
		raw = r.URL.Query().Get("token")
	}
	if raw == "" {
		return false
	}
	computed := hash(raw, b.cfg.Salt)
	return hmac.Equal([]byte(computed), []byte(b.token))
}

// handleHTTPRes finishes a bridged request with the subscriber's response.
// Whoever removes the task from the map is the one allowed to write the
// response, so it can never race with gcTasks.
func (b *Bridge) handleHTTPRes(m resMsg) {
	if m.Data == "" && m.Code == 0 {
		return
	}
	b.mu.Lock()
	t, ok := b.tasks[m.ID]
	if ok {
		delete(b.tasks, m.ID)
		b.taskc--
	}
	b.mu.Unlock()
	if !ok {
		return
	}
	if m.Data != "" {
		buf, err := base64.StdEncoding.DecodeString(m.Data)
		if err != nil {
			t.res.WriteHeader(http.StatusInternalServerError)
		} else {
			h := t.res.Header()
			for k, v := range m.Headers {
				h.Set(textproto.CanonicalMIMEHeaderKey(k), v)
			}
			if h.Get("Content-Length") != "" {
				h.Set("Content-Length", strconv.Itoa(len(buf)))
			}
			t.res.Write(buf)
		}
	} else {
		t.res.WriteHeader(m.Code)
	}
	close(t.done)
}

// handleAPI bridges a client request to a registered subscriber.
func (b *Bridge) handleAPI(w http.ResponseWriter, r *http.Request, entry string) {
	var data *string
	if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch {
		body, ok := readLimited(r.Body, bodyLimit)
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if len(body) > 0 {
			b64 := base64.StdEncoding.EncodeToString(body)
			data = &b64
		}
	}

	b.mu.Lock()
	l := b.lbs[entry]
	if l == nil || !l.HasConn() {
		b.mu.Unlock()
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	if b.cfg.RateLimit > 0 && b.taskc >= b.cfg.RateLimit {
		b.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	id := (b.hid + 1) % httpMaxID
	dst := l.GetOne(id)
	if dst == nil {
		b.mu.Unlock()
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	l.CancelOne(id)
	b.hid = id
	t := &task{ts: time.Now(), res: w, done: make(chan struct{})}
	b.tasks[id] = t
	b.taskc++
	b.mu.Unlock()

	hdr := make(map[string]string, len(r.Header))
	for k, vs := range r.Header {
		hdr[k] = strings.Join(vs, ", ")
	}
	msg := reqMsg{
		Type:    "req",
		ID:      id,
		Method:  r.Method,
		URI:     r.URL.RequestURI(),
		Data:    data,
		Headers: hdr,
	}
	// If the send fails (subscriber gone) the task simply times out with 504.
	dst.SendJSON(msg)

	<-t.done
}

// readLimited reads up to max bytes; ok is false when the body is larger.
func readLimited(r io.Reader, max int) ([]byte, bool) {
	b, err := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if err != nil || len(b) > max {
		return nil, false
	}
	return b, true
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
