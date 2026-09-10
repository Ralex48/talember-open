package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProbeAndHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/privacy" {
			w.WriteHeader(503)
		}
	}))
	defer server.Close()
	s := probe(context.Background(), server.Client(), server.URL)
	if s.OK || len(s.Checks) != 4 {
		t.Fatal("failure must be visible")
	}
	m := &monitor{latest: s}
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 503 {
		t.Fatal("failed probe reported healthy")
	}
	m.latest = snapshot{OK: true, Timestamp: time.Now().Unix() - 181}
	w = httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 503 {
		t.Fatal("stale probe reported healthy")
	}
	m.latest.Timestamp = time.Now().Unix()
	w = httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 {
		t.Fatal("fresh healthy result rejected")
	}
}
func TestRestrictedConfiguration(t *testing.T) {
	for _, p := range [][2]string{{"http://example.com", "127.0.0.1:9188"}, {"https://user:pass@example.com", "127.0.0.1:9188"}, {"https://example.com", "0.0.0.0:9188"}} {
		if validate(p[0], p[1]) == nil {
			t.Fatal("unsafe configuration accepted")
		}
	}
	if validate("https://example.com", "127.0.0.1:9188") != nil {
		t.Fatal("valid configuration rejected")
	}
}
