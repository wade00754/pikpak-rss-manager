package web

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/wade00754/pikpak-rss-manager/internal/feed"
	"github.com/wade00754/pikpak-rss-manager/internal/model"
	"github.com/wade00754/pikpak-rss-manager/internal/pikpak"
	"github.com/wade00754/pikpak-rss-manager/internal/rename"
	"github.com/wade00754/pikpak-rss-manager/internal/store"
	"github.com/wade00754/pikpak-rss-manager/internal/worker"
	"html/template"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed templates/*.html static/*
var assets embed.FS

type session struct{ until time.Time }
type attempt struct {
	count int
	until time.Time
}

type CloudManager interface {
	Snapshot() (pikpak.API, string)
	Status() pikpak.Status
	Reconnect(context.Context) error
	Bind(context.Context, string) error
}
type Server struct {
	backfillMu sync.Mutex
	backfills  map[string]*backfillPlan
	DB         *store.Store
	Manager    CloudManager
	Worker     *worker.Worker
	Version    string
	hash       string
	accountKey []byte
	settings   store.AppSettings
	ready      chan struct{}
	authGate   chan struct{}
	templates  *template.Template
	mu         sync.Mutex
	sessions   map[string]session
	attempts   map[string]attempt
}

func New(db *store.Store, m CloudManager, w *worker.Worker, version string) (*Server, error) {
	accountKey := make([]byte, 32)
	if _, err := rand.Read(accountKey); err != nil {
		return nil, errors.New("無法初始化帳號參照")
	}
	hash, settings, err := db.Administrator(context.Background())
	if err != nil {
		return nil, errors.New("無法讀取管理員設定")
	}
	if hash != "" {
		if _, _, err := passwordParts(hash); err != nil {
			return nil, err
		}
	}
	t, err := template.ParseFS(assets, "templates/*.html")
	if err != nil {
		return nil, err
	}
	s := &Server{DB: db, Manager: m, Worker: w, Version: version, hash: hash, accountKey: accountKey, settings: settings, ready: make(chan struct{}), authGate: make(chan struct{}, 1), templates: t, sessions: map[string]session{}, attempts: map[string]attempt{}}
	if w != nil {
		w.SetFeeds(feed.New(settings.AllowPrivateFeeds))
	}
	if hash != "" {
		close(s.ready)
	}
	return s, nil
}

func nonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (s *Server) cookie(w http.ResponseWriter, r *http.Request, name, value string, httpOnly bool, maxAge int) {
	secure := r.TLS != nil || strings.HasPrefix(s.appSettings().PublicURL, "https://")
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: httpOnly, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func (s *Server) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie("pp_session")
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for key, v := range s.sessions {
		if !now.Before(v.until) {
			delete(s.sessions, key)
		}
	}
	value, ok := s.sessions[cookie.Value]
	return ok && now.Before(value.until)
}
func (s *Server) csrf(w http.ResponseWriter, r *http.Request) string {
	c, err := r.Cookie("pp_csrf")
	if err == nil && len(c.Value) == 43 {
		return c.Value
	}
	value := nonce()
	s.cookie(w, r, "pp_csrf", value, false, 43200)
	return value
}
func (s *Server) validCSRF(r *http.Request) bool {
	c, err := r.Cookie("pp_csrf")
	if err != nil || len(c.Value) != 43 || r.Header.Get("X-CSRF-Token") != c.Value {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if publicURL := s.appSettings().PublicURL; publicURL != "" {
			return origin == publicURL
		}
		u, err := url.Parse(origin)
		// Before setup, allow the browser's same-host HTTPS origin behind a
		// TLS-terminating proxy without trusting arbitrary forwarding headers.
		return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
	}
	return true
}
func JSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, err error) {
	code := 400
	message := err.Error()
	if errors.Is(err, sql.ErrNoRows) {
		code = 404
		message = "找不到項目"
	}
	JSON(w, code, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("請使用 application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return errors.New("請求資料格式不正確或過大")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("請求只能包含單一 JSON 物件")
	}
	return nil
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(assets, "static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(static))))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.DB.Ping(r.Context()); err != nil {
			JSON(w, 503, map[string]string{"status": "unavailable"})
			return
		}
		JSON(w, 200, map[string]string{"status": "ok", "version": s.Version})
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		s.csrf(w, r)
		name := "login.html"
		if !s.initialized() {
			name = "setup.html"
		} else if s.authenticated(r) {
			name = "app.html"
			status := pikpak.Status{}
			if s.Manager != nil {
				status = s.Manager.Status()
			}
			if !status.Connected && status.Source == "" {
				name = "onboarding.html"
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = s.templates.ExecuteTemplate(w, name, map[string]string{"Version": s.Version})
	})
	mux.HandleFunc("GET /api/session", func(w http.ResponseWriter, r *http.Request) {
		JSON(w, 200, map[string]any{"initialized": s.initialized(), "authenticated": s.authenticated(r), "csrf": s.csrf(w, r), "version": s.Version})
	})
	mux.HandleFunc("POST /api/setup", s.setup)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.protected(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("pp_session")
		if c != nil {
			s.mu.Lock()
			delete(s.sessions, c.Value)
			s.mu.Unlock()
		}
		s.cookie(w, r, "pp_session", "", true, -1)
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/subscriptions", s.protected(func(w http.ResponseWriter, r *http.Request) {
		subs, err := s.DB.Subscriptions(r.Context())
		if err != nil {
			JSON(w, 500, map[string]string{"error": "無法讀取訂閱"})
			return
		}
		for i := range subs {
			s.directoryReference(&subs[i])
		}
		JSON(w, 200, subs)
	}))
	mux.HandleFunc("POST /api/subscriptions", s.protected(s.saveSubscription))
	mux.HandleFunc("PUT /api/subscriptions/{id}", s.protected(s.saveSubscription))
	mux.HandleFunc("DELETE /api/subscriptions/{id}", s.protected(func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			failure(w, errors.New("訂閱 ID 無效"))
			return
		}
		if err := s.Worker.DeleteSubscription(r.Context(), id); err != nil {
			failure(w, errors.New("無法刪除訂閱"))
			return
		}
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/subscriptions/{id}/check", s.protected(func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			failure(w, errors.New("訂閱 ID 無效"))
			return
		}
		var in struct {
			Backfill bool `json:"backfill"`
		}
		if err := decode(w, r, &in); err != nil {
			failure(w, err)
			return
		}
		if in.Backfill {
			failure(w, errors.New("請先讀取補抓清單並勾選下載項目"))
			return
		}
		if err := s.Worker.Check(r.Context(), id, false); err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/feeds/samples", s.protected(s.sourceSamples))
	mux.HandleFunc("POST /api/subscriptions/{id}/backfill/preview", s.protected(s.previewBackfill))
	mux.HandleFunc("POST /api/subscriptions/{id}/backfill", s.protected(s.confirmBackfill))
	mux.HandleFunc("POST /api/rules/preview", s.protected(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Rule     model.Rule `json:"rule"`
			Filename string     `json:"filename"`
		}
		if err := decode(w, r, &in); err != nil {
			failure(w, err)
			return
		}
		preview, err := rename.Render(in.Rule, in.Filename)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, preview)
	}))
	mux.HandleFunc("GET /api/jobs", s.protected(func(w http.ResponseWriter, r *http.Request) {
		jobs, err := s.DB.Jobs(r.Context(), 200)
		if err != nil {
			JSON(w, 500, map[string]string{"error": "無法讀取任務"})
			return
		}
		JSON(w, 200, jobs)
	}))
	mux.HandleFunc("POST /api/jobs", s.protected(s.createJob))
	mux.HandleFunc("DELETE /api/jobs/completed", s.protected(func(w http.ResponseWriter, r *http.Request) {
		count, err := s.Worker.ClearCompletedJobs(r.Context())
		if err != nil {
			JSON(w, 500, map[string]string{"error": "無法清除已完成任務"})
			return
		}
		JSON(w, 200, map[string]int64{"deleted": count})
	}))
	mux.HandleFunc("DELETE /api/jobs/{id}", s.protected(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			LocalOnly bool `json:"local_only"`
		}
		if r.ContentLength != 0 {
			if err := decode(w, r, &in); err != nil {
				failure(w, err)
				return
			}
		}
		count, err := s.Worker.DeleteJob(r.Context(), r.PathValue("id"), in.LocalOnly)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]int64{"deleted": count})
	}))
	mux.HandleFunc("GET /api/jobs/{id}", s.protected(func(w http.ResponseWriter, r *http.Request) {
		job, err := s.DB.Job(r.Context(), r.PathValue("id"))
		if err != nil {
			failure(w, errors.New("找不到任務"))
			return
		}
		actions, err := s.DB.Actions(r.Context(), job.ID)
		if err != nil {
			JSON(w, 500, map[string]string{"error": "無法讀取逐檔紀錄"})
			return
		}
		JSON(w, 200, map[string]any{"job": job, "files": actions})
	}))
	mux.HandleFunc("POST /api/jobs/{id}/retry", s.protected(func(w http.ResponseWriter, r *http.Request) {
		if err := s.Worker.Retry(r.Context(), r.PathValue("id")); err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/events", s.protected(func(w http.ResponseWriter, r *http.Request) {
		events, err := s.DB.Events(r.Context())
		if err != nil {
			JSON(w, 500, map[string]string{"error": "無法讀取日誌"})
			return
		}
		JSON(w, 200, events)
	}))
	mux.HandleFunc("GET /api/settings/pikpak", s.protected(func(w http.ResponseWriter, r *http.Request) { JSON(w, 200, s.Manager.Status()) }))
	mux.HandleFunc("GET /api/settings/app", s.protected(func(w http.ResponseWriter, r *http.Request) { JSON(w, 200, s.appSettings()) }))
	mux.HandleFunc("POST /api/settings/app", s.protected(s.saveAppSettings))
	mux.HandleFunc("POST /api/settings/password", s.protected(s.changePassword))
	mux.HandleFunc("GET /api/pikpak/folders", s.protected(s.browseDirectories))
	mux.HandleFunc("POST /api/pikpak/folders", s.protected(s.addDirectory))
	mux.HandleFunc("POST /api/settings/pikpak", s.protected(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Token string `json:"token"`
		}
		if err := decode(w, r, &in); err != nil {
			failure(w, err)
			return
		}
		s.Worker.Gate.Lock()
		defer s.Worker.Gate.Unlock()
		if err := s.Manager.Bind(r.Context(), strings.TrimSpace(in.Token)); err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, s.Manager.Status())
	}))
	mux.HandleFunc("POST /api/settings/pikpak/check", s.protected(func(w http.ResponseWriter, r *http.Request) {
		s.Worker.Gate.Lock()
		defer s.Worker.Gate.Unlock()
		if err := s.Manager.Reconnect(r.Context()); err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, s.Manager.Status())
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) protected(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authenticated(r) {
			JSON(w, 401, map[string]string{"error": "請先登入"})
			return
		}
		if r.Method != "GET" && !s.validCSRF(r) {
			JSON(w, 403, map[string]string{"error": "請求驗證失敗，請重新整理頁面"})
			return
		}
		h(w, r)
	}
}
func (s *Server) saveSubscription(w http.ResponseWriter, r *http.Request) {
	var sub model.Subscription
	if err := decode(w, r, &sub); err != nil {
		failure(w, err)
		return
	}
	sub.ID = 0
	if r.Method == "PUT" {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			failure(w, errors.New("訂閱 ID 無效"))
			return
		}
		sub.ID = id
	}
	if sub.IntervalMinutes < 1 || sub.IntervalMinutes > 10080 {
		failure(w, errors.New("檢查間隔必須為 1–10080 分鐘"))
		return
	}
	if err := feed.ValidateURL(sub.RSSURL); err != nil {
		failure(w, err)
		return
	}
	if sub.DestinationID == "" {
		destination, err := rename.Destination(sub.Destination)
		if err != nil {
			failure(w, err)
			return
		}
		sub.Destination = destination
	}
	if err := rename.Validate(sub.Rule()); err != nil {
		failure(w, err)
		return
	}
	if sub.DestinationID != "" {
		if err := s.resolveDestination(r.Context(), &sub); err != nil {
			failure(w, err)
			return
		}
	}
	if err := s.Worker.SaveSubscription(r.Context(), &sub); err != nil {
		failure(w, errors.New("無法保存訂閱"))
		return
	}
	s.directoryReference(&sub)
	JSON(w, 200, sub)
}
