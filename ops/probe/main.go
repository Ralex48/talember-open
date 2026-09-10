// A read-only, loopback-only public-page probe. No payment or generation calls.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type result struct {
	Path         string `json:"path"`
	Status       int    `json:"status"`
	Milliseconds int64  `json:"milliseconds"`
	OK           bool   `json:"ok"`
}
type snapshot struct {
	Timestamp int64    `json:"timestamp"`
	OK        bool     `json:"ok"`
	Checks    []result `json:"checks"`
}
type monitor struct {
	mu     sync.RWMutex
	latest snapshot
}

func probe(ctx context.Context, client *http.Client, origin string) snapshot {
	s := snapshot{Timestamp: time.Now().Unix(), OK: true}
	for _, path := range []string{"/", "/support?lang=en", "/privacy?lang=ru", "/refunds?lang=es"} {
		start := time.Now()
		r := result{Path: path}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+path, nil)
		if err == nil {
			resp, e := client.Do(req)
			if e == nil {
				r.Status = resp.StatusCode
				_, e = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
				resp.Body.Close()
				r.OK = e == nil && r.Status >= 200 && r.Status < 300
			}
		}
		r.Milliseconds = time.Since(start).Milliseconds()
		s.Checks = append(s.Checks, r)
		s.OK = s.OK && r.OK
	}
	return s
}
func (m *monitor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	m.mu.RLock()
	s := m.latest
	m.mu.RUnlock()
	switch r.URL.Path {
	case "/healthz":
		if !s.OK || time.Now().Unix()-s.Timestamp > 180 {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	case "/status":
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s)
	case "/metrics":
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		up := 0
		if s.OK {
			up = 1
		}
		fmt.Fprintf(w, "talember_site_up %d\ntalember_last_probe_timestamp_seconds %d\n", up, s.Timestamp)
		for _, c := range s.Checks {
			fmt.Fprintf(w, "talember_probe_duration_seconds{path=%q} %.3f\n", c.Path, float64(c.Milliseconds)/1000)
		}
	default:
		http.NotFound(w, r)
	}
}
func validate(origin, address string) error {
	u, e := url.Parse(origin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("origin must be an HTTPS origin without credentials, path or query")
	}
	host, _, e := net.SplitHostPort(address)
	if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("listener must use a loopback IP")
	}
	return nil
}
func main() {
	origin := flag.String("origin", "https://example.com", "Public HTTPS origin")
	address := flag.String("listen", "127.0.0.1:9188", "Loopback listening address")
	flag.Parse()
	if e := validate(*origin, *address); e != nil {
		log.Fatal(e)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	m := &monitor{}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	go func() {
		for {
			s := probe(ctx, client, *origin)
			m.mu.Lock()
			m.latest = s
			m.mu.Unlock()
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Minute):
			}
		}
	}()
	server := &http.Server{Addr: *address, Handler: m, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(c)
	}()
	if e := server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal("probe listener failed")
	}
}
