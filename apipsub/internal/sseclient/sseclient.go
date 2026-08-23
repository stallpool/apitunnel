// Package sseclient is a minimal client for a Server-Sent Events stream.
// The sub uses it to receive bridged request tasks from the pub.
package sseclient

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Stream is one open SSE stream from the pub.
type Stream struct {
	events chan event
	cancel context.CancelFunc
}

type event struct {
	msg string
	err error
}

// Dial opens the SSE stream at rawurl, adding the token, lb and lb_n query
// params. It returns once the pub has accepted the connection (HTTP 200).
func Dial(ctx context.Context, rawurl, token, lb string, lbN int) (*Stream, error) {
	u, err := url.Parse(rawurl)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if token != "" {
		q.Set("token", token)
	}
	if lb != "" {
		q.Set("lb", lb)
	}
	if lbN > 0 {
		q.Set("lb_n", strconv.Itoa(lbN))
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		resp.Body.Close()
		return nil, errors.New("response is not text/event-stream")
	}

	sctx, cancel := context.WithCancel(ctx)
	s := &Stream{
		events: make(chan event, 32),
		cancel: cancel,
	}
	go s.read(resp.Body, sctx)
	return s, nil
}

// Read blocks until the next message or a terminal error. ok is false once
// the stream is closed.
func (s *Stream) Read() (msg string, err error, ok bool) {
	e, ok := <-s.events
	if !ok {
		return "", nil, false
	}
	return e.msg, e.err, true
}

// Close stops reading the stream.
func (s *Stream) Close() {
	s.cancel()
}

// read parses the SSE stream into events. It sends a message event per
// "data" block and a terminal error event on read failure, then returns.
func (s *Stream) read(body io.Reader, ctx context.Context) {
	defer close(s.events)
	br := bufio.NewReader(body)
	var data []string
	emit := func(e event) {
		select {
		case s.events <- e:
		case <-ctx.Done():
		}
	}
	for {
		line, err := br.ReadString('\n')
		if n := len(line); n > 0 {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if len(data) > 0 {
					emit(event{msg: strings.Join(data, "\n")})
					data = data[:0]
				}
			case !strings.HasPrefix(line, ":") && strings.HasPrefix(line, "data:"):
				v := strings.TrimPrefix(line, "data:")
				if strings.HasPrefix(v, " ") {
					v = v[1:]
				}
				data = append(data, v)
			}
			// other SSE fields (event/id/retry) and comments are ignored
		}
		if err != nil {
			if err != io.EOF {
				emit(event{err: err})
			}
			return
		}
	}
}
