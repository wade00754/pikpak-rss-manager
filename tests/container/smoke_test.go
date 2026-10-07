package container

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type dockerRunner func(context.Context, ...string) (string, error)

func runDocker(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Dir = filepath.Join("..", "..")
	cmd.WaitDelay = 3 * time.Second
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker %s: %w\n%s", args[0], err, output)
	}
	return strings.TrimSpace(string(output)), nil
}

func TestComposeSmoke(t *testing.T) {
	if os.Getenv("CONTAINER_SMOKE_TEST") != "1" {
		t.Skip("run make test-container to test an image with Docker")
	}
	ctx, stop := signal.NotifyContext(t.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 7*time.Minute)
	defer cancel()
	version, err := composeSmoke(ctx, runDocker, smokeOptions{
		image:           os.Getenv("SMOKE_IMAGE"),
		platform:        os.Getenv("SMOKE_PLATFORM"),
		expectedVersion: os.Getenv("SMOKE_EXPECTED_VERSION"),
		baseURL:         "http://127.0.0.1:8080",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("PASS: Compose startup without env file, version %s, Web setup, login after restart, regex previews, non-root and subscription persistence", version)
}

type smokeOptions struct {
	image, platform, expectedVersion, baseURL string
}

func composeOverride(image, platform string) ([]byte, error) {
	service := map[string]string{"image": image}
	if platform != "" {
		service["platform"] = platform
	}
	// JSON is valid YAML, including safely quoted digest-based image names.
	return json.Marshal(map[string]any{"services": map[string]any{"pikpak-rss-manager": service}})
}

func composeSmoke(ctx context.Context, docker dockerRunner, options smokeOptions) (version string, err error) {
	if options.image == "" {
		options.image = "ghcr.io/wade00754/pikpak-rss-manager:latest"
	}
	directory, err := os.MkdirTemp("", "rss-smoke-")
	if err != nil {
		return "", err
	}
	defer func() { err = errors.Join(err, os.RemoveAll(directory)) }()
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	project := "rss-smoke-" + hex.EncodeToString(random[:4])
	// A short random password verifies the absence of minimum-length rules.
	password := hex.EncodeToString(random[4:])
	override, err := composeOverride(options.image, options.platform)
	if err != nil {
		return "", err
	}
	overridePath := filepath.Join(directory, "override.json")
	if err := os.WriteFile(overridePath, override, 0600); err != nil {
		return "", err
	}
	// Explicitly bypass Compose's automatic loading of a local .env file.
	envPath := filepath.Join(directory, "empty.env")
	if err := os.WriteFile(envPath, nil, 0600); err != nil {
		return "", err
	}
	command := []string{"compose", "--env-file", envPath, "-p", project, "-f", "docker-compose.yml", "-f", overridePath}
	compose := func(ctx context.Context, args ...string) (string, error) {
		return docker(ctx, append(append([]string(nil), command...), args...)...)
	}
	defer func() {
		// Cleanup must still run when the main request context is cancelled.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_, cleanupErr := compose(cleanupCtx, "down", "--volumes", "--remove-orphans")
		if cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("cleanup project %s: %w", project, cleanupErr))
		}
	}()
	if _, err := compose(ctx, "config", "--quiet"); err != nil {
		return "", err
	}
	if _, err := compose(ctx, "up", "-d", "--pull", "never"); err != nil {
		return "", err
	}
	client, err := newSmokeClient(options.baseURL)
	if err != nil {
		return "", err
	}
	if err := client.ready(ctx); err != nil {
		return "", err
	}
	container, err := compose(ctx, "ps", "-q", "pikpak-rss-manager")
	if err != nil {
		return "", err
	}
	if container == "" || strings.ContainsAny(container, "\r\n") {
		return "", errors.New("expected exactly one Compose service container")
	}
	user, err := docker(ctx, "inspect", "--format", "{{.Config.User}}", container)
	if err != nil {
		return "", err
	}
	if user != "65532:65532" {
		return "", errors.New("container is not running as the expected non-root user")
	}
	if _, err := docker(ctx, "exec", container, "/app/pikpak-rss-manager", "healthcheck"); err != nil {
		return "", err
	}
	version, err = docker(ctx, "exec", container, "/app/pikpak-rss-manager", "version")
	if err != nil {
		return "", err
	}
	if version == "" || options.expectedVersion != "" && version != options.expectedVersion {
		return "", errors.New("unexpected application version")
	}
	if err := client.checkInitial(ctx, version); err != nil {
		return "", err
	}
	subscriptionID, err := client.initialize(ctx, password, version)
	if err != nil {
		return "", err
	}
	if _, err := compose(ctx, "down"); err != nil {
		return "", err
	}
	if _, err := compose(ctx, "up", "-d", "--pull", "never"); err != nil {
		return "", err
	}
	if err := client.ready(ctx); err != nil {
		return "", err
	}
	return version, client.checkRestored(ctx, password, subscriptionID)
}

type smokeClient struct {
	client  *http.Client
	baseURL string
	csrf    string
}

func newSmokeClient(baseURL string) (*smokeClient, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &smokeClient{client: &http.Client{Jar: jar, Timeout: 10 * time.Second}, baseURL: baseURL}, nil
}

func (c *smokeClient) request(ctx context.Context, method, path string, value any, status int, result any) error {
	var body io.Reader
	if value != nil {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", c.baseURL)
	req.Header.Set("X-CSRF-Token", c.csrf)
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s failed: %w", method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != status {
		return fmt.Errorf("%s %s: expected HTTP %d, got %d", method, path, status, resp.StatusCode)
	}
	if result != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(result); err != nil {
			return fmt.Errorf("%s: invalid JSON response: %w", path, err)
		}
	}
	return nil
}

func (c *smokeClient) ready(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	for {
		var health struct{ Status string }
		if err := c.request(ctx, "GET", "/healthz", nil, 200, &health); err == nil && health.Status == "ok" {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("container health timeout: %w", ctx.Err())
		case <-time.After(time.Second):
		}
	}
}

type smokeSession struct {
	CSRF        string
	Version     string
	Initialized bool
}

func (c *smokeClient) session(ctx context.Context) (smokeSession, error) {
	var session smokeSession
	err := c.request(ctx, "GET", "/api/session", nil, 200, &session)
	c.csrf = session.CSRF
	return session, err
}

func (c *smokeClient) checkPageContent(ctx context.Context, content string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/", nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	page, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 || !strings.Contains(string(page), content) {
		return errors.New("expected page content missing")
	}
	return nil
}

func (c *smokeClient) checkInitial(ctx context.Context, version string) error {
	var health struct{ Version string }
	if err := c.request(ctx, "GET", "/healthz", nil, 200, &health); err != nil {
		return err
	}
	session, err := c.session(ctx)
	if err != nil {
		return err
	}
	if health.Version != version || session.Version != version || session.Initialized {
		return errors.New("unexpected health/session version or pre-existing setup")
	}
	if err := c.checkPageContent(ctx, `id="setup-form"`); err != nil {
		return err
	}
	return c.request(ctx, "GET", "/api/subscriptions", nil, 401, nil)
}

type smokeSubscription struct {
	ID            int64
	RSSURL        string `json:"rss_url"`
	RenameEnabled bool   `json:"rename_enabled"`
}

func (c *smokeClient) initialize(ctx context.Context, password, version string) (int64, error) {
	setup := map[string]any{"password": password, "confirm_password": password, "public_url": c.baseURL, "allow_private_feeds": false}
	// Explicitly exercise CSRF rejection before a valid setup.
	csrf := c.csrf
	c.csrf = ""
	err := c.request(ctx, "POST", "/api/setup", setup, 403, nil)
	c.csrf = csrf
	if err != nil {
		return 0, err
	}
	if err := c.request(ctx, "POST", "/api/setup", setup, 200, nil); err != nil {
		return 0, err
	}
	session, err := c.session(ctx)
	if err != nil {
		return 0, err
	}
	if !session.Initialized {
		return 0, errors.New("Web setup did not initialize the administrator")
	}
	if err := c.request(ctx, "POST", "/api/setup", setup, 409, nil); err != nil {
		return 0, err
	}
	if err := c.checkPageContent(ctx, `data-onboarding="true"`); err != nil {
		return 0, err
	}
	var subscription smokeSubscription
	if err := c.request(ctx, "POST", "/api/subscriptions", map[string]any{
		"name": "持久化測試", "rss_url": "https://example.org/feed?private=ci-only",
		"destination": "Test", "enabled": false, "interval_minutes": 10,
		"rename_enabled": false, "regex": "", "replacement": "",
	}, 200, &subscription); err != nil {
		return 0, err
	}
	if subscription.ID <= 0 || subscription.RenameEnabled {
		return 0, errors.New("subscription did not preserve disabled naming")
	}
	for _, sample := range []struct {
		filename, regex, replacement, raw, normalized string
		warning                                       bool
	}{
		{"作品_03.mkv", `^(?P<title>.+)_(?P<ep>\d+)\.(?P<ext>[^.]+)$`, "${title} - E${ep}.${ext}", "作品 - E03.mkv", "作品 - E03.mkv", false},
		{"中文 / English [01].mkv", `\[(\d+)\]`, "S01E$1", "中文 / English S01E01.mkv", "中文 _ English S01E01.mkv", true},
	} {
		var preview struct {
			OldName  string `json:"old_name"`
			Name     string
			RawName  string `json:"raw_name"`
			Matched  bool
			Warnings []string
		}
		if err := c.request(ctx, "POST", "/api/rules/preview", map[string]any{
			"rule":     map[string]any{"title": "命名測試", "rename_enabled": true, "regex": sample.regex, "replacement": sample.replacement},
			"filename": sample.filename,
		}, 200, &preview); err != nil {
			return 0, err
		}
		if preview.OldName != sample.filename || !preview.Matched || preview.RawName != sample.raw || preview.Name != sample.normalized || (len(preview.Warnings) > 0) != sample.warning {
			return 0, errors.New("regex preview or filename normalization mismatch")
		}
	}
	return subscription.ID, nil
}

func (c *smokeClient) checkRestored(ctx context.Context, password string, subscriptionID int64) error {
	session, err := c.session(ctx)
	if err != nil {
		return err
	}
	if !session.Initialized {
		return errors.New("administrator setup did not persist")
	}
	if err := c.request(ctx, "POST", "/api/login", map[string]string{"password": password}, 200, nil); err != nil {
		return err
	}
	var subscriptions []smokeSubscription
	if err := c.request(ctx, "GET", "/api/subscriptions", nil, 200, &subscriptions); err != nil {
		return err
	}
	if len(subscriptions) != 1 || subscriptions[0].ID != subscriptionID || subscriptions[0].RSSURL != "https://example.org/feed?private=ci-only" || subscriptions[0].RenameEnabled {
		return errors.New("subscription data did not persist after restart")
	}
	return nil
}
