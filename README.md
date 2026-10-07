# PikPak RSS Manager

A self-hosted Go service for PikPak RSS/Atom subscriptions and offline downloads. Uses the official PikPak MCP with PAT authentication and per-subscription naming rules.

## Start

Requires Docker and Docker Compose. Download [docker-compose.yml](docker-compose.yml), then run from its directory:

```sh
docker compose up -d
```

On the same machine, open [http://127.0.0.1:8080](http://127.0.0.1:8080) and follow setup: create a password, confirm the public URL, then connect a PikPak PAT. The dashboard opens after verification. Update the PAT later in **Settings**.

Compose listens on localhost only. For remote access, configure an HTTPS reverse proxy using the [deployment guide](docs/deployment.md), which also covers 1Panel and process settings.

### PAT permissions

[Create a PAT](https://mypikpak.com/en-US/help-center/connected_apps/personal_access_tokens/create_personal_access_token) with:

| Permission | Purpose |
|---|---|
| **Read & write files** | Browses/creates folders and renames files. |
| **Cloud Download** | Creates offline download tasks. |

## Use

- **Subscriptions:** choose an RSS URL, destination and interval. First check establishes a baseline. **Backfill** selects whole torrents. Repeated explicit downloads are allowed.
- **Offline tasks:** submit a Magnet, torrent URL or HTTP/HTTPS download URL. **Delete task** cancels incomplete downloads while preserving files. **Clear completed tasks** removes completed records only.
- **Renaming:** disabled by default. Regex replacement supports `$1`, `${name}` and `$$`. Nonmatches keep their names. Select a torrent filename to preview. PikPak rejects renaming to a duplicate filename in the same folder. Resolve the name conflict before resuming the task.
- **Destinations:** browse/create folders or enter a path. Reselect saved folders after switching accounts.

## Update

Back up the full data volume, including `secret.key`, then run:

```sh
docker compose pull
docker compose up -d
```

## Development

Requires Go 1.27.1, GNU Make and Node.js. Run from the repository root:

```sh
make dev
make verify
```

Use `make help` for individual targets. [Architecture/API](docs/architecture.md) · [Authentication](docs/architecture.md#authentication) · [Testing](docs/architecture.md#testing).
