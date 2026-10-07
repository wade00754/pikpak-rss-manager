package web

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/wade00754/pikpak-rss-manager/internal/config"
	"github.com/wade00754/pikpak-rss-manager/internal/feed"
	"github.com/wade00754/pikpak-rss-manager/internal/store"
	"golang.org/x/crypto/argon2"
)

const passwordPrefix = "$argon2id$v=19$m=65536,t=3,p=2$"

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", errors.New("無法建立密碼驗證值")
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return passwordPrefix + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(hash), nil
}

// Bound parameters and lengths before processing a persisted verifier. A
// damaged record fails closed instead of opening first setup again.
func passwordParts(verifier string) ([]byte, []byte, error) {
	if strings.HasPrefix(verifier, passwordPrefix) {
		parts := strings.Split(strings.TrimPrefix(verifier, passwordPrefix), "$")
		if len(parts) == 2 {
			salt, e1 := base64.RawStdEncoding.DecodeString(parts[0])
			hash, e2 := base64.RawStdEncoding.DecodeString(parts[1])
			if e1 == nil && e2 == nil && len(salt) == 16 && len(hash) == 32 {
				return salt, hash, nil
			}
		}
	}
	return nil, nil, errors.New("密碼驗證值損毀；請保留資料並還原備份")
}

func verifyPassword(verifier, password string) bool {
	salt, expected, err := passwordParts(verifier)
	if err != nil {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func (s *Server) initialized() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hash != ""
}

func (s *Server) Ready() <-chan struct{} { return s.ready }

func (s *Server) appSettings() store.AppSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

// Rate-limit attempts and allow only one memory-hard operation at a time.
func (s *Server) beginAuth(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	s.mu.Lock()
	now := time.Now()
	for k, a := range s.attempts {
		if !now.Before(a.until) {
			delete(s.attempts, k)
		}
	}
	a := s.attempts[host]
	if a.count >= 8 && now.Before(a.until) {
		s.mu.Unlock()
		JSON(w, 429, map[string]string{"error": "登入嘗試過多，請一分鐘後再試"})
		return false
	}
	a.count++
	a.until = now.Add(time.Minute)
	s.attempts[host] = a
	s.mu.Unlock()
	select {
	case s.authGate <- struct{}{}:
		return true
	default:
		JSON(w, 429, map[string]string{"error": "正在處理其他登入或初始化請求，請稍後再試"})
		return false
	}
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	value := nonce()
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	s.mu.Lock()
	s.sessions[value] = session{time.Now().Add(12 * time.Hour)}
	delete(s.attempts, host)
	s.mu.Unlock()
	s.cookie(w, r, "pp_session", value, true, 43200)
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	if !s.validCSRF(r) {
		JSON(w, 403, map[string]string{"error": "請求驗證失敗"})
		return
	}
	if s.initialized() {
		JSON(w, 409, map[string]string{"error": "初始化已完成，請登入"})
		return
	}
	var in struct {
		Password        string `json:"password"`
		ConfirmPassword string `json:"confirm_password"`
		store.AppSettings
	}
	if err := decode(w, r, &in); err != nil {
		failure(w, err)
		return
	}
	if in.Password == "" {
		failure(w, errors.New("請輸入密碼"))
		return
	}
	if in.Password != in.ConfirmPassword {
		failure(w, errors.New("兩次輸入的密碼不一致"))
		return
	}
	publicURL, err := config.NormalizePublicURL(in.PublicURL)
	if err != nil {
		failure(w, err)
		return
	}
	in.PublicURL = publicURL
	if !s.beginAuth(w, r) {
		return
	}
	defer func() { <-s.authGate }()
	hash, err := hashPassword(in.Password)
	in.Password, in.ConfirmPassword = "", ""
	if err != nil {
		failure(w, err)
		return
	}
	created, err := s.DB.InitializeAdministrator(r.Context(), hash, in.AppSettings)
	if err != nil {
		JSON(w, 500, map[string]string{"error": "無法儲存初始化設定，請重試"})
		return
	}
	if !created {
		JSON(w, 409, map[string]string{"error": "初始化已完成，請重新整理並登入"})
		return
	}
	if s.Worker != nil {
		s.Worker.Gate.Lock()
		defer s.Worker.Gate.Unlock()
		s.Worker.SetFeeds(feed.New(in.AllowPrivateFeeds))
	}
	s.mu.Lock()
	s.hash, s.settings = hash, in.AppSettings
	close(s.ready)
	s.mu.Unlock()
	// Reissue CSRF after HTTPS configuration is known; do not leave a
	// non-Secure first-setup cookie behind a TLS-terminating proxy.
	s.cookie(w, r, "pp_csrf", nonce(), false, 43200)
	s.createSession(w, r)
	JSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.validCSRF(r) {
		JSON(w, 403, map[string]string{"error": "請求驗證失敗"})
		return
	}
	if !s.initialized() {
		JSON(w, 409, map[string]string{"error": "請先完成初始化"})
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if err := decode(w, r, &in); err != nil {
		failure(w, err)
		return
	}
	if !s.beginAuth(w, r) {
		return
	}
	defer func() { <-s.authGate }()
	s.mu.Lock()
	hash := s.hash
	s.mu.Unlock()
	matched := verifyPassword(hash, in.Password)
	in.Password = ""
	if !matched {
		JSON(w, 401, map[string]string{"error": "密碼不正確"})
		return
	}
	s.createSession(w, r)
	JSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
		ConfirmPassword string `json:"confirm_password"`
	}
	if err := decode(w, r, &in); err != nil {
		failure(w, err)
		return
	}
	if in.CurrentPassword == "" {
		failure(w, errors.New("請輸入目前密碼"))
		return
	}
	if in.NewPassword == "" {
		failure(w, errors.New("請輸入新密碼"))
		return
	}
	if in.NewPassword != in.ConfirmPassword {
		failure(w, errors.New("兩次輸入的密碼不一致"))
		return
	}
	if !s.beginAuth(w, r) {
		return
	}
	defer func() { <-s.authGate }()
	// A request may have passed middleware before another change revoked it.
	if !s.authenticated(r) {
		JSON(w, 401, map[string]string{"error": "請先登入"})
		return
	}
	s.mu.Lock()
	previous := s.hash
	s.mu.Unlock()
	matched := verifyPassword(previous, in.CurrentPassword)
	in.CurrentPassword = ""
	if !matched {
		failure(w, errors.New("目前密碼不正確"))
		return
	}
	hash, err := hashPassword(in.NewPassword)
	in.NewPassword, in.ConfirmPassword = "", ""
	if err != nil {
		failure(w, err)
		return
	}
	if err := s.DB.ChangeAdministratorPassword(r.Context(), previous, hash); err != nil {
		JSON(w, 500, map[string]string{"error": "無法保存密碼，請重試"})
		return
	}
	s.mu.Lock()
	s.hash = hash
	clear(s.sessions)
	s.mu.Unlock()
	s.cookie(w, r, "pp_session", "", true, -1)
	s.cookie(w, r, "pp_csrf", nonce(), false, 43200)
	JSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) saveAppSettings(w http.ResponseWriter, r *http.Request) {
	var in store.AppSettings
	if err := decode(w, r, &in); err != nil {
		failure(w, err)
		return
	}
	publicURL, err := config.NormalizePublicURL(in.PublicURL)
	if err != nil {
		failure(w, err)
		return
	}
	in.PublicURL = publicURL
	if s.Worker != nil {
		s.Worker.Gate.Lock()
		defer s.Worker.Gate.Unlock()
	}
	if err := s.DB.SaveAppSettings(r.Context(), in); err != nil {
		JSON(w, 500, map[string]string{"error": "無法保存網站設定"})
		return
	}
	s.mu.Lock()
	s.settings = in
	s.mu.Unlock()
	if s.Worker != nil {
		s.Worker.SetFeeds(feed.New(in.AllowPrivateFeeds))
	}
	s.cookie(w, r, "pp_csrf", nonce(), false, 43200)
	// Keep the current session and renew its transport attributes.
	if cookie, err := r.Cookie("pp_session"); err == nil {
		s.cookie(w, r, "pp_session", cookie.Value, true, 43200)
	}
	JSON(w, 200, in)
}
