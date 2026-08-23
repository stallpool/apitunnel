// Package sse implements the subscriber-side transport of the tunnel:
// a long-lived Server-Sent Events stream from pub to sub.
package sse

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const keepAlive = 15 * time.Second

// Client is one subscriber connected to the pub server over SSE.
type Client struct {
	Entry string
	IP    string

	cid int // assigned by IdBindLoadBalance; guarded by the bridge lock

	mu     sync.Mutex
	w      http.ResponseWriter
	closed atomic.Bool
}

func NewClient(w http.ResponseWriter, entry, ip string) *Client {
	return &Client{Entry: entry, IP: ip, w: w}
}

// Begin writes the SSE headers, flushes them and starts the keep-alive
// writer. It must be called exactly once, before the client is added to a
// load balancer.
func (c *Client) Begin(ctx context.Context) {
	h := c.w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	c.w.WriteHeader(http.StatusOK)
	c.flush()
	go c.keepAlive(ctx)
}

// Close marks the client as closed so that further sends are dropped.
func (c *Client) Close() {
	c.closed.Store(true)
}

// SendJSON writes v to the subscriber as one SSE "data" event.
func (c *Client) SendJSON(v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	out := make([]byte, 0, len(b)+8)
	out = append(out, "data: "...)
	out = append(out, b...)
	out = append(out, '\n', '\n')
	return c.write(out)
}

func (c *Client) write(b []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed.Load() {
		return false
	}
	if _, err := c.w.Write(b); err != nil {
		c.closed.Store(true)
		return false
	}
	c.flush()
	return true
}

func (c *Client) flush() {
	if f, ok := c.w.(http.Flusher); ok {
		f.Flush()
	}
}

// keepAlive emits an SSE comment periodically so proxies and clients do not
// time out idle streams.
func (c *Client) keepAlive(ctx context.Context) {
	t := time.NewTicker(keepAlive)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.write([]byte(": ping\n\n"))
		}
	}
}

// Cid and SetCid implement lb.Conn.
func (c *Client) Cid() int     { return c.cid }
func (c *Client) SetCid(v int) { c.cid = v }
