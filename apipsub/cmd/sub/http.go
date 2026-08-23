package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// httpTimeout bounds each bridged backend request (the JS sub used 20s).
const httpTimeout = 20 * time.Second

// allowedReqHeaders limits which client request headers reach the backend
// (security feature: prevents leaking cookies, host, etc.).
var allowedReqHeaders = map[string]bool{
	"content-type":   true,
	"user-agent":     true,
	"content-length": true,
	"authorization":  true,
}

// httpReq is one bridged request pushed by the pub over SSE.
type httpReq struct {
	ID      int               `json:"id"`
	Method  string            `json:"method"`
	URI     string            `json:"uri"`
	Data    *string           `json:"data"`
	Headers map[string]string `json:"headers"`
}

// resMsg is posted back to the pub with the bridged response.
type resMsg struct {
	Type    string            `json:"type"`
	ID      int               `json:"id"`
	Code    int               `json:"code,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Data    string            `json:"data,omitempty"`
}

type httpResult struct {
	buf      []byte
	headers  map[string]string
	redirect string
	failed   bool
}

// handleHttp executes a bridged request and posts the result back to the pub.
func (s *Sub) handleHttp(m httpReq) {
	if m.ID == 0 || m.Method == "" || m.URI == "" {
		return
	}
	res, err := s.processHttp(m)
	if err != nil || res.redirect != "" || res.failed {
		s.postRes(resMsg{Type: "res", ID: m.ID, Code: 500})
		return
	}
	s.postRes(resMsg{
		Type:    "res",
		ID:      m.ID,
		Headers: res.headers,
		Data:    base64.StdEncoding.EncodeToString(res.buf),
	})
}

// processHttp renders the target url and executes the request.
func (s *Sub) processHttp(m httpReq) (httpResult, error) {
	parts := strings.Split(m.URI, "/")
	// JS sub: parts.shift(); parts.shift(); region=parts.shift(); site=parts.shift(); remain=parts.join('/')
	// For URI=/pub/cowk/-/api/v1/llm/model parts=["","pub","cowk","-","api/v1/llm/model"]
	if len(parts) < 5 {
		return httpResult{}, fmt.Errorf("uri has %d parts (need >=5): %q", len(parts), m.URI)
	}
	region := parts[2]
	site := parts[3]
	remain := strings.Join(parts[4:], "/")

	target := s.config.RenderURL("http", region, site, remain)
	if target == "" {
		return httpResult{}, fmt.Errorf(`no http region %q`, region)
	}

	hdr := http.Header{}
	for k, v := range m.Headers {
		if allowedReqHeaders[strings.ToLower(k)] {
			hdr.Set(k, v)
		}
	}
	var body io.Reader
	if m.Method == http.MethodPost || m.Method == http.MethodPut || m.Method == http.MethodPatch {
		if m.Data != nil {
			buf, err := base64.StdEncoding.DecodeString(*m.Data)
			if err != nil {
				return httpResult{}, err
			}
			body = bytes.NewReader(buf)
			// the JS set content-type application/json when the body is JSON
			if json.Valid(buf) {
				hdr.Set("Content-Type", "application/json")
			}
		}
	}
	return s.download(target, m.Method, body, hdr)
}

// download performs the request against the backend and normalizes the
// result, mirroring the legacy JS sub/request.js.
func (s *Sub) download(target, method string, body io.Reader, hdr http.Header) (httpResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return httpResult{failed: true}, err
	}
	req.Header = hdr
	resp, err := s.client.Do(req)
	if err != nil {
		return httpResult{failed: true}, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case 301, 302, 304, 307:
		loc := resp.Header.Get("Location")
		if loc == "" {
			return httpResult{failed: true}, nil
		}
		base, _ := url.Parse(target)
		if strings.HasPrefix(loc, "//") {
			loc = base.Scheme + ":" + loc
		} else if !strings.Contains(loc, "://") {
			if ref, perr := url.Parse(loc); perr == nil {
				loc = base.ResolveReference(ref).String()
			}
		}
		return httpResult{redirect: loc}, nil
	case 200, 201, 204:
		buf, err := io.ReadAll(resp.Body)
		if err != nil {
			return httpResult{failed: true}, err
		}
		h := make(map[string]string, len(resp.Header))
		for k, vs := range resp.Header {
			h[k] = strings.Join(vs, ", ")
		}
		return httpResult{buf: buf, headers: h}, nil
	case 404:
		if strings.HasSuffix(target, "/index.html") {
			return httpResult{redirect: target[:strings.LastIndex(target, "/")+1]}, nil
		}
	}
	return httpResult{failed: true}, nil
}

// postRes posts a bridged response back to the pub.
func (s *Sub) postRes(m resMsg) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, s.pubURL, bytes.NewReader(b))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if s.cfg.Token != "" {
		req.Header.Set("X-Pub-Token", s.cfg.Token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("[E] %s post: %v", ts(), err)
		return
	}
	resp.Body.Close()
}
