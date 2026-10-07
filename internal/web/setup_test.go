package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wade00754/pikpak-rss-manager/internal/store"
)

func TestFirstWebSetupAndRestart(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(db, nil, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s.Handler())
	configuredOrigin := server.URL
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	csrf := ""
	request := func(method, path string, value any, origin string) (int, string) {
		t.Helper()
		var body io.Reader
		if value != nil {
			b, _ := json.Marshal(value)
			body = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, server.URL+path, body)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", csrf)
		req.Header.Set("Origin", origin)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	refreshCSRF := func() bool {
		t.Helper()
		_, body := request("GET", "/api/session", nil, "")
		var state struct {
			CSRF        string `json:"csrf"`
			Initialized bool   `json:"initialized"`
		}
		if err := json.Unmarshal([]byte(body), &state); err != nil {
			t.Fatal(err)
		}
		csrf = state.CSRF
		return state.Initialized
	}
	if code, body := request("GET", "/", nil, ""); code != 200 || !strings.Contains(body, `id="setup-form"`) {
		t.Fatal("missing initial setup page")
	}
	select {
	case <-s.Ready():
		t.Fatal("worker enabled before setup")
	default:
	}
	if refreshCSRF() {
		t.Fatal("fresh database already initialized")
	}
	password := "web-init-sentinel-🔑-" + strings.Repeat("long-", 30)
	setup := map[string]any{"password": password, "confirm_password": password, "public_url": server.URL, "allow_private_feeds": true}
	csrf = ""
	if code, _ := request("POST", "/api/setup", setup, server.URL); code != 403 {
		t.Fatal("setup missing CSRF accepted")
	}
	refreshCSRF()
	if code, _ := request("POST", "/api/setup", setup, "https://evil.test"); code != 403 {
		t.Fatal("cross-origin setup accepted")
	}
	if code, _ := request("POST", "/api/login", map[string]string{"password": password}, server.URL); code != 409 {
		t.Fatal("login allowed before setup")
	}
	for _, path := range []string{"/api/subscriptions", "/api/settings/app", "/api/settings/pikpak"} {
		if code, _ := request("GET", path, nil, ""); code != 401 {
			t.Fatal("anonymous management access", path)
		}
	}
	for _, invalid := range []map[string]any{
		{"password": "", "confirm_password": ""},
		{"password": "x", "confirm_password": "y"},
		{"password": "x", "confirm_password": "x", "public_url": "https://user:secret@example.org"},
	} {
		if code, _ := request("POST", "/api/setup", invalid, server.URL); code != 400 {
			t.Fatal("invalid setup accepted")
		}
	}
	if code, body := request("POST", "/api/setup", setup, server.URL); code != 200 || strings.Contains(body, password) || strings.Contains(body, "$argon2id$") {
		t.Fatal("setup failed or disclosed verifier")
	}
	select {
	case <-s.Ready():
	default:
		t.Fatal("setup did not enable worker")
	}
	if !refreshCSRF() {
		t.Fatal("setup state not persisted")
	}
	if code, body := request("GET", "/", nil, ""); code != 200 || !strings.Contains(body, `data-onboarding="true"`) {
		t.Fatal("setup did not create session")
	}
	if code, _ := request("POST", "/api/setup", map[string]string{"password": "overwrite", "confirm_password": "overwrite"}, server.URL); code != 409 {
		t.Fatal("completed setup could be overwritten")
	}
	if code, body := request("GET", "/api/settings/app", nil, ""); code != 200 || !strings.Contains(body, `"allow_private_feeds":true`) || strings.Contains(body, "$argon2id$") {
		t.Fatal("settings not available or leaked verifier")
	}
	newSettings := store.AppSettings{PublicURL: server.URL, AllowPrivateFeeds: false}
	csrf = ""
	if code, _ := request("POST", "/api/settings/app", newSettings, server.URL); code != 403 {
		t.Fatal("settings missing CSRF accepted")
	}
	refreshCSRF()
	if code, _ := request("POST", "/api/settings/app", newSettings, server.URL); code != 200 {
		t.Fatal("settings update failed")
	}
	refreshCSRF()
	if code, _ := request("POST", "/api/logout", map[string]any{}, server.URL); code != 200 {
		t.Fatal("logout failed")
	}
	if code, _ := request("POST", "/api/setup", setup, server.URL); code != 409 {
		t.Fatal("anonymous reinitialization allowed")
	}
	// Inspect live SQLite/WAL files and the closed database. The original
	// password must never appear anywhere in the persistent data directory.
	checkFiles := func() {
		t.Helper()
		if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			b, err := os.ReadFile(path)
			if err == nil && bytes.Contains(b, []byte(password)) {
				t.Fatal("plaintext password persisted", entry.Name())
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	checkFiles()
	server.Close()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	checkFiles()
	db, err = store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	restarted, err := New(db, nil, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server = httptest.NewServer(restarted.Handler())
	defer server.Close()
	jar, _ = cookiejar.New(nil)
	client.Jar = jar
	if !refreshCSRF() {
		t.Fatal("restart reopened initialization")
	}
	if code, body := request("GET", "/", nil, ""); code != 200 || !strings.Contains(body, `id="login-form"`) || strings.Contains(body, `id="setup-form"`) {
		t.Fatal("restart missing login page")
	}
	if code, _ := request("POST", "/api/login", map[string]string{"password": password + "!"}, configuredOrigin); code != 401 {
		t.Fatal("incorrect long password accepted")
	}
	if code, _ := request("POST", "/api/login", map[string]string{"password": password}, configuredOrigin); code != 200 {
		t.Fatal("persisted password did not log in")
	}
	if code, body := request("GET", "/api/settings/app", nil, ""); code != 200 || !strings.Contains(body, `"allow_private_feeds":false`) {
		t.Fatal("changed settings lost on restart")
	}
}

func TestHTTPSProxySetupAndLoginRateLimit(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s, err := New(db, nil, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	handler := s.Handler()
	page := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://panel.test/", nil)
	handler.ServeHTTP(page, req)
	csrf := page.Result().Cookies()[0]
	post := func(path string, value any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(value)
		req := httptest.NewRequest("POST", "http://panel.test"+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://panel.test")
		req.Header.Set("X-CSRF-Token", csrf.Value)
		req.AddCookie(csrf)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	response := post("/api/setup", map[string]any{"password": "x", "confirm_password": "x", "public_url": "https://panel.test"})
	if response.Code != 200 {
		t.Fatal("TLS-terminating proxy setup rejected", response.Code)
	}
	for _, cookie := range response.Result().Cookies() {
		if !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
			t.Fatal("HTTPS cookie not protected")
		}
		if cookie.Name == "pp_csrf" {
			csrf = cookie
		}
		if cookie.Name == "pp_session" && !cookie.HttpOnly {
			t.Fatal("session accessible to scripts")
		}
	}
	for i := 0; i < 8; i++ {
		if response := post("/api/login", map[string]string{"password": "wrong"}); response.Code != 401 {
			t.Fatal("unexpected login limit", i, response.Code)
		}
	}
	if response := post("/api/login", map[string]string{"password": "x"}); response.Code != 429 {
		t.Fatal("login rate limit not enforced")
	}
}

func TestCorruptAdministratorDoesNotReopenSetup(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.InitializeAdministrator(context.Background(), "invalid-verifier", store.AppSettings{}); err != nil {
		t.Fatal(err)
	}
	if _, err := New(db, nil, nil, "test"); err == nil {
		t.Fatal("corrupted verifier reopened setup")
	}
}
