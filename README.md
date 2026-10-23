# PikPak RSS Manager

A self-hosted Go service for PikPak RSS/Atom subscriptions and offline downloads. Uses the official PikPak MCP with PAT authentication and per-subscription naming rules.

## Start

Requires Docker and Docker Compose. Download [docker-compose.yml](docker-compose.yml), then run from its directory:

```sh
docker compose up -d
```

On the same machine, open [http://127.0.0.1:8080](http://127.0.0.1:8080) and follow setup: create a password, confirm the public URL, then connect a PikPak PAT. The dashboard opens after verification. Overview combines subscriptions and offline tasks. Open **Settings** or **Logs** from the account menu. Update the PAT in **Settings**.

Compose listens on localhost only. For remote access, configure an HTTPS reverse proxy using the [deployment guide](docs/deployment.md), which also covers 1Panel and process settings.

Forgot the password? Open **Forgot password** on the login page and follow the [recovery steps](docs/deployment.md#password-recovery). Server access is required.

### PAT permissions

[Create a PAT](https://mypikpak.com/en-US/help-center/connected_apps/personal_access_tokens/create_personal_access_token) with:

| Permission | Purpose |
|---|---|
| **Read & write files** | Browses/creates folders and renames files. |
| **Cloud Download** | Creates offline download tasks. |

## Use

- **Subscriptions:** choose an RSS URL, destination and interval. Use the card’s play/pause control to toggle tracking. Click the card for subscription and naming settings. The **Manage subscription** section provides checking, **Backfill** and deletion. First check establishes a baseline. Backfill selects whole torrents. Repeated explicit downloads are allowed.
- **Offline tasks:** submit a Magnet, torrent URL or HTTP/HTTPS download URL. Click a task for status and details. Tasks are grouped into attention, active and completed sections. **Delete task** cancels incomplete downloads while preserving files. The brush icon beside **Completed** removes completed local records only.
- **Renaming:** disabled by default. Regex replacement supports `$1`, `${name}` and `$$`. Nonmatches keep their names. Enabling renaming loads torrent filenames for preview. Select a filename to test the rule and use the refresh icon to reload. PikPak rejects renaming to a duplicate filename in the same folder. Resolve the name conflict before resuming the task.
- **Destinations:** browse/create folders or enter a path. Reselect saved folders after switching accounts.

## Update

Back up the full data volume, including `secret.key`, then run:

```sh
docker compose pull
docker compose up -d
```

## Development

Requires Go 1.27.1, GNU Make and Node.js 24 with npm. Run from the repository root:

```sh
make frontend-install
make dev             # Go service on http://127.0.0.1:8080
# In a second terminal:
make dev-frontend    # Vite + React on http://127.0.0.1:5173/ui/
make verify
```

Vite proxies the Go API for hot reload. Set `VITE_BACKEND_URL` when using a different backend URL. Keep the development site URL set to the backend origin. `make build` embeds the frontend in the Go binary, which needs no Node runtime.

Use `make help` for individual targets. [Architecture/API](docs/architecture.md) · [Authentication](docs/architecture.md#authentication) · [Testing](docs/architecture.md#testing).
