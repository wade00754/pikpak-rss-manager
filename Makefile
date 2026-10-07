.DEFAULT_GOAL := help
.NOTPARALLEL:

GO ?= go
NODE ?= node
IMAGE ?= ghcr.io/wade00754/pikpak-rss-manager:latest
VERSION := $(strip $(file <cmd/pikpak-rss-manager/VERSION))

ifeq ($(OS),Windows_NT)
SHELL := cmd.exe
.SHELLFLAGS := /c
EXE := .exe
endif

BINARY ?= .local/pikpak-rss-manager$(EXE)

.PHONY: help dev version build check-format test test-race vet test-ui verify docker-build test-container test-manifest

help:
	@echo make dev             - run the development service
	@echo make version         - print the application version
	@echo make build           - build into .local
	@echo make check-format    - check Go formatting without rewriting files
	@echo make test            - run Go tests
	@echo make test-race       - run Go tests with the race detector
	@echo make vet             - run Go static checks
	@echo make test-ui         - check JavaScript syntax and translations
	@echo make verify          - run formatting, tests, vet, UI checks and build
	@echo make docker-build    - build IMAGE with Docker
	@echo make test-container  - test IMAGE startup and persistence with Docker
	@echo make test-manifest   - check IMAGE has linux/amd64 and linux/arm64

dev:
	$(GO) run ./cmd/pikpak-rss-manager

version:
	$(GO) run ./cmd/pikpak-rss-manager version

build:
	$(GO) build -trimpath -o $(BINARY) ./cmd/pikpak-rss-manager

check-format: export FORMAT_CHECK = 1
check-format:
	$(GO) test ./tests/tooling -run ^TestGoFormatting$$ -count=1

test:
	$(GO) test ./...

test-race:
	$(GO) test -race -count=1 ./...

vet:
	$(GO) vet ./...

test-ui:
	$(NODE) --check internal/web/static/app.js
	$(NODE) --check internal/web/static/theme.js
	$(NODE) --check internal/web/static/backfill.js
	$(NODE) --check internal/web/static/i18n.js
	$(NODE) tests/web/i18n.test.cjs
	$(NODE) tests/web/direct.test.cjs
	$(NODE) tests/web/onboarding.test.cjs

verify: check-format test vet test-ui build

docker-build:
	docker build --build-arg VERSION=$(VERSION) -t "$(IMAGE)" .

test-container: export CONTAINER_SMOKE_TEST = 1
test-container: export SMOKE_IMAGE = $(IMAGE)
test-container:
	$(GO) test ./tests/container -run ^TestComposeSmoke$$ -count=1 -v -timeout=10m

test-manifest: export CONTAINER_MANIFEST_TEST = 1
test-manifest: export SMOKE_IMAGE = $(IMAGE)
test-manifest:
	$(GO) test ./tests/container -run ^TestPublishedArchitectures$$ -count=1 -v
