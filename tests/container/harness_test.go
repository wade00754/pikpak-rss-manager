package container

import (
	"context"
	"debug/elf"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/wade00754/pikpak-rss-manager/internal/feed"
	"github.com/wade00754/pikpak-rss-manager/internal/pikpak"
	"github.com/wade00754/pikpak-rss-manager/internal/store"
	"github.com/wade00754/pikpak-rss-manager/internal/web"
	"github.com/wade00754/pikpak-rss-manager/internal/worker"
)

func TestSmokeHarnessWithIsolatedWebService(t *testing.T) {
	dataDir := t.TempDir()
	var mu sync.RWMutex
	var handler http.Handler
	var db *store.Store
	var manager *pikpak.Manager
	stop := func() {
		mu.Lock()
		defer mu.Unlock()
		handler = nil
		if manager != nil {
			manager.Close()
			manager = nil
		}
		if db != nil {
			_ = db.Close()
			db = nil
		}
	}
	defer stop()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		defer mu.RUnlock()
		if handler == nil {
			w.WriteHeader(503)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	starts, cleanups := 0, 0
	runner := func(ctx context.Context, args ...string) (string, error) {
		if args[0] == "inspect" {
			if args[2] == "{{.Image}}" {
				return "fixture-image-id", nil
			}
			return "65532:65532", nil
		}
		if args[0] == "image" {
			if args[len(args)-1] != "fixture-image-id" {
				t.Fatal("architecture inspection must use the container's image ID")
			}
			return "linux/amd64", nil
		}
		if args[0] == "cp" {
			return "", os.WriteFile(args[2], elfFixture(elf.EM_X86_64), 0600)
		}
		if args[0] == "exec" {
			if args[len(args)-1] == "version" {
				return "fixture", nil
			}
			return "", nil
		}
		for i, arg := range args {
			switch arg {
			case "--env-file":
				data, err := os.ReadFile(args[i+1])
				if err != nil || len(data) != 0 {
					t.Fatal("smoke test must explicitly use an empty env file")
				}
			case "up":
				mu.Lock()
				defer mu.Unlock()
				var err error
				db, err = store.Open(dataDir)
				if err != nil {
					return "", err
				}
				manager = pikpak.NewManager(db)
				w := worker.New(db, manager, feed.New(false))
				ui, err := web.New(db, manager, w, "fixture")
				if err != nil {
					return "", err
				}
				handler = ui.Handler()
				starts++
				return "", nil
			case "down":
				stop()
				if strings.Contains(strings.Join(args, " "), "--volumes") {
					cleanups++
				}
				return "", nil
			case "ps":
				return "fixture-container", nil
			}
		}
		return "", nil
	}
	version, err := composeSmoke(t.Context(), runner, smokeOptions{image: "fixture-image", expectedVersion: "fixture", baseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if version != "fixture" || starts != 2 || cleanups != 1 {
		t.Fatalf("unexpected lifecycle: version=%s starts=%d cleanups=%d", version, starts, cleanups)
	}
}

func TestSmokeCleanupAfterFailureAndCancellation(t *testing.T) {
	startupErr := errors.New("startup failed")
	cleanupErr := errors.New("cleanup failed")
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "failure", true: "cancelled"}[cancelled], func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			cleaned := false
			var temporaryDirectory string
			runner := func(ctx context.Context, args ...string) (string, error) {
				for i, arg := range args {
					if arg == "--env-file" {
						temporaryDirectory = args[i+1]
					}
				}
				if args[len(args)-1] == "--remove-orphans" {
					if ctx.Err() != nil {
						t.Fatal("cleanup inherited cancelled startup context")
					}
					cleaned = true
					return "", cleanupErr
				}
				if cancelled {
					cancel()
					return "", ctx.Err()
				}
				return "", startupErr
			}
			_, err := composeSmoke(ctx, runner, smokeOptions{image: "fixture"})
			wanted := startupErr
			if cancelled {
				wanted = context.Canceled
			}
			if !cleaned || !errors.Is(err, wanted) || !errors.Is(err, cleanupErr) {
				t.Fatalf("startup and cleanup errors must both survive: %v", err)
			}
			if _, err := os.Stat(temporaryDirectory); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("temporary Compose settings were retained")
			}
		})
	}
}

func TestComposeOverrideQuotesImageAndPlatform(t *testing.T) {
	image := "registry.example/fixture@sha256:" + strings.Repeat("a", 64)
	encoded, err := composeOverride(image, "linux/arm64")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Services map[string]struct{ Image, Platform string }
	}
	if err := json.Unmarshal(encoded, &config); err != nil {
		t.Fatal(err)
	}
	service := config.Services["pikpak-rss-manager"]
	if service.Image != image || service.Platform != "linux/arm64" {
		t.Fatal("override lost image digest or platform")
	}
}

func TestSmokeHTTPStatusAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	client, err := newSmokeClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.request(t.Context(), "GET", "/api/subscriptions", nil, 401, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.request(t.Context(), "GET", "/api/subscriptions", nil, 200, nil); err == nil {
		t.Fatal("unexpected HTTP status accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := client.ready(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("health wait did not honor cancellation: %v", err)
	}
}
