// Command pub runs the apitunnel pub server (Go port of pub/index.js).
//
// It bridges client http requests to registered subscribers. The
// sub<->pub channel is SSE (GET /sub/<entry>) + HTTP POST
// (POST /sub/<entry>); websocket is not used.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	"apitunnel/apipsub/internal/bridge"
	"apitunnel/apipsub/internal/env"
)

func main() {
	cfg := env.Load()
	b := bridge.New(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go b.Run(ctx)

	ln, err := net.Listen("tcp", cfg.Host+":"+strconv.Itoa(cfg.Port))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("APITUNNEL-pub is listening at %s:%d ...", cfg.Host, cfg.Port)

	srv := &http.Server{Handler: b}
	errc := make(chan error, 1)
	go func() {
		if cfg.CA != "" {
			errc <- srv.ServeTLS(ln,
				filepath.Join(cfg.CA, "ca.crt"),
				filepath.Join(cfg.CA, "ca.key"))
		} else {
			errc <- srv.Serve(ln)
		}
	}()

	var serveErr error
	select {
	case serveErr = <-errc:
	case <-ctx.Done():
		if derr := srv.Shutdown(context.Background()); derr != nil {
			log.Printf("[W] shutdown: %v", derr)
		}
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		log.Fatal(serveErr)
	}
}
