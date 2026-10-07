package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wade00754/pikpak-rss-manager/internal/pikpak"
	"github.com/wade00754/pikpak-rss-manager/internal/store"
)

type onboardingManager struct{ status pikpak.Status }

func (m *onboardingManager) Snapshot() (pikpak.API, string)     { return nil, "fixture-account" }
func (m *onboardingManager) Status() pikpak.Status              { return m.status }
func (m *onboardingManager) Reconnect(context.Context) error    { return nil }
func (m *onboardingManager) Bind(context.Context, string) error { return nil }

func TestOnboardingPageSelection(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     pikpak.Status
		onboarding bool
	}{
		{"new administrator", pikpak.Status{}, true},
		{"connected", pikpak.Status{Connected: true, Source: "database"}, false},
		{"expired saved PAT after restart", pikpak.Status{Source: "database", Paused: "auth"}, false},
		{"quota paused", pikpak.Status{Connected: true, Source: "database", Paused: "quota"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := initializedServer(t, "x", store.AppSettings{}, nil, &onboardingManager{tc.status}, nil)
			if err != nil {
				t.Fatal(err)
			}
			handler := s.Handler()
			page := httptest.NewRecorder()
			handler.ServeHTTP(page, httptest.NewRequest("GET", "/", nil))
			if !strings.Contains(page.Body.String(), `id="login-form"`) || strings.Contains(page.Body.String(), `id="token-form"`) {
				t.Fatal("connection setup exposed before login")
			}
			s.sessions["fixture-session"] = session{time.Now().Add(time.Hour)}
			req := httptest.NewRequest("GET", "/", nil)
			req.AddCookie(&http.Cookie{Name: "pp_session", Value: "fixture-session"})
			page = httptest.NewRecorder()
			handler.ServeHTTP(page, req)
			body := page.Body.String()
			if page.Code != 200 || strings.Contains(body, `data-onboarding="true"`) != tc.onboarding {
				t.Fatal("incorrect onboarding state")
			}
			if strings.Contains(body, `id="view-overview"`) == tc.onboarding {
				t.Fatal("dashboard shown in incorrect state")
			}
			if strings.Contains(body, "connection-banner") || strings.Contains(body, "先到「系統設定」") || strings.Contains(body, "關於授權與配額") {
				t.Fatal("repeated setup guidance remains")
			}
			if tc.onboarding && (!strings.Contains(body, `aria-current="step"`) || !strings.Contains(body, `id="token-error"`)) {
				t.Fatal("connection step missing progress or inline error")
			}
		})
	}
}
