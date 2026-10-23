package web_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/wade00754/pikpak-rss-manager/internal/feed"
	"github.com/wade00754/pikpak-rss-manager/internal/pikpak"
	"github.com/wade00754/pikpak-rss-manager/internal/store"
	"github.com/wade00754/pikpak-rss-manager/internal/testutil"
	"github.com/wade00754/pikpak-rss-manager/internal/web"
	"github.com/wade00754/pikpak-rss-manager/internal/worker"
)

type fixtureManager struct {
	mu        sync.Mutex
	db        *store.Store
	cloud     *testutil.Cloud
	connected bool
}

func (m *fixtureManager) Snapshot() (pikpak.API, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.connected {
		return nil, ""
	}
	return m.cloud, m.cloud.AccountID
}
func (m *fixtureManager) Status() pikpak.Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.connected {
		return pikpak.Status{}
	}
	return pikpak.Status{Connected: true, Source: "database", Name: "Fixture account", StorageTotal: "10.00 TB", StorageUsed: "2.50 TB"}
}
func (m *fixtureManager) Bind(ctx context.Context, token string) error {
	if token != "fixture-pat" {
		return errors.New("請輸入 PikPak PAT")
	}
	if err := m.db.SetSetting(ctx, "pikpak_token", token); err != nil {
		return err
	}
	m.mu.Lock()
	m.connected = true
	m.mu.Unlock()
	return nil
}
func (m *fixtureManager) Reconnect(context.Context) error { return nil }
func (m *fixtureManager) Pause(*pikpak.Error)             {}

// TestBrowserFixture serves only isolated local fixtures. It never contacts PikPak.
func TestBrowserFixture(t *testing.T) {
	if os.Getenv("PIKPAK_BROWSER_FIXTURE") != "1" {
		t.Skip("opt-in browser fixture")
	}
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	m := &fixtureManager{db: db, cloud: testutil.NewCloud()}
	w := worker.New(db, m, feed.New(false))
	s, err := web.New(db, m, w, "browser-fixture")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	t.Log("UI_FIXTURE_URL=" + server.URL)
	var source *httptest.Server
	source = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sample.torrent" {
			w.Header().Set("Content-Type", "application/x-bittorrent")
			name := "[Fixture] Example - 01.mkv"
			fmt.Fprintf(w, "d4:infod6:lengthi1e4:name%d:%s12:piece lengthi16384e6:pieces20:00000000000000000000ee", len(name), name)
			return
		}
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprintf(w, `<rss version="2.0"><channel><title>Fixture feed</title><item><title>Fixture episode</title><enclosure url="%s/sample.torrent" type="application/x-bittorrent" /></item></channel></rss>`, source.URL)
	}))
	defer source.Close()
	t.Log("RSS_FIXTURE_URL=" + source.URL)
	// A file signal allows the browser driver to finish and run deferred cleanup.
	for deadline := time.Now().Add(15 * time.Minute); time.Now().Before(deadline); {
		if stop := os.Getenv("PIKPAK_BROWSER_STOP"); stop != "" {
			if _, err := os.Stat(stop); err == nil {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("browser fixture timed out")
}
