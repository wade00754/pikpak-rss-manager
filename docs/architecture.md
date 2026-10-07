# Architecture and API

One Go process, one administrator, one active PikPak account and one SQLite data volume. HTML/CSS/JavaScript are embedded. No frontend build step or local media transfer.

| Module | Responsibility |
|---|---|
| internal/web | UI, sessions, CSRF, language catalog, API |
| internal/feed | RSS/Atom, bounded torrent metadata, normalized infohashes |
| internal/rename | Shared regex replacement renderer and filename normalization |
| internal/pikpak | Typed official MCP adapter and folder operations |
| internal/worker | Durable queue, reconciliation, file actions and bounded retry |
| internal/store | SQLite migrations, baseline, repeat-download migration, encryption |

## Workflow

Subscriptions establish a baseline on first check. Backfill is explicit. Manual tasks have subscription_id 0 and never modify feed baselines. Torrent tasks retain normalized infohashes as resource identifiers. Direct download URLs use an exact-URL SHA-256 key. Resource identity does not suppress repeated explicit downloads. Automatic checks skip previously seen feed fingerprints.

The worker saves queued → submitting before the cloud request, then stores the task ID and polls downloading → organizing → complete. All jobs submit directly to the destination ID. Submission intent remains durable across restarts and account switches. Unconfirmed submissions become submission_unknown. Without a task ID they require manual verification and never scan the destination or resubmit. Official file IDs are retained from submission and polling. Completed download-only jobs need no file ID. Renaming requires official file IDs. Authorization/quota failures pause jobs. Transient failures back off from 30 seconds to two hours, with review after six attempts.

Deletion shares the worker/account lock with submission and file actions. Incomplete jobs with a task ID are checked against their owning account and canceled once through optional official `task_rm`, explicitly setting `delete-files:false`. Failure preserves the local job. An absent remote task permits deletion. Unknown submissions without an ID require manual cancellation and explicit `local_only:true`. This flag cannot bypass cancellation of a known task. Completed deletion makes no cloud call. Local deletion atomically removes jobs/file actions and stores ID tombstones, retaining feed baselines and event history. Tombstones prevent repeated confirmation requests from recreating deleted jobs. A new explicit download still receives a new ID. Clearing completed jobs includes records outside the latest-200 list.

Jobs rename primary files in place inside the official returned file/folder ID, preserving torrent structure and auxiliary filenames/locations. File actions persist original/requested names, parent IDs and renaming intent before each call, then read back actual_name (including any returned suffix). A lost response is reconciled by ID without repeating the rename. An unchanged name requires review. The short review message asks users to check name conflicts before retrying. PikPak rejects renaming to a duplicate filename in the same folder, but this guidance does not classify every unconfirmed result as a duplicate. Existing stored review messages receive the updated UI copy in both languages. Task details show the current filename once and include a labeled original only when it differs. A requested rename is not shown as the current name when an original is available. Regex replacement works on actual filenames. Nonmatches retain their names. Renaming is disabled by default.

Backfill preview reads one RSS snapshot and each distinct torrent URL once, with bounded concurrency and metadata/output budgets. Session/account-bound plans expire after 15 minutes. Confirmations validate the subscription and destination again, then atomically queue whole torrents using stable job IDs.

## Limits and security

PAT requires Read & write files and Cloud Download. The MCP adapter has no move, Trash or permanent-deletion operations. Jobs do not create staging, backup or attachment folders, scan destination differences, overwrite or clean cloud content. Manual destination paths can create their explicitly named folders. SQLite migrations remain, but staged-job and template-rule compatibility is removed.

- Feed/torrent metadata: 2 MiB per resource. Full sample reads: one feed snapshot, each distinct torrent once, at most five concurrent requests, 32 MiB total metadata, 10,000 filenames/8 MiB output, 90-second overall and 15-second torrent timeouts. Partial successes are retained.
- Preview reads metadata only. It does not submit tasks or change baselines. The shared renderer returns raw_name, normalized name and warnings.
- Selected folder IDs carry opaque account references. The server revalidates IDs/account ownership. Folder creation is sent once. Uncertain results require review.
- First-run UI: administrator creation, then PAT connection. Authenticated users without a saved or connected account resume the connection step. Saved accounts retain the dashboard when authorization expires. Connection errors appear in Settings.
- First-run password: nonempty, salted Argon2id verifier. PATs/private URLs: AES-GCM with a persistent secret.key. Credentials are never returned or logged. No external password/PAT sources or .env loading.
- Sessions: 12 hours, memory only. Mutations require matching CSRF cookie/header and same-origin checks. HTTP-only/SameSite cookies, login throttling and CSP are enabled.
- Management pages place theme and language controls in the sidebar footer with connection status, version and sign-out. The footer remains accessible on narrow screens. Navigation and theme icons use a consistent 20 px size. Desktop navigation uses a 12 px icon-to-label gap. Setup and login retain their header controls.
- UI language is a browser preference. Only application literals and message fields are translated. Names, paths, URLs, regex and filenames remain intact.

## Authentication

PAT authentication is implemented. Create a token through PikPak and enter it in Settings. Replace it before expiry. The service stores the bearer token encrypted with AES-GCM.

OAuth is researched only. Discovery checked on 2026-10-03 advertised authorization code, PKCE S256, refresh tokens and client registration. Registration, callbacks, consent and refresh flows have not been implemented or tested. Discovery declarations do not prove those flows will succeed for this service.

The permission documentation reviewed at that time restricted permanent deletion and invitations through both PAT and hosted MCP. OAuth does not automatically unlock them. Connected apps share monthly traffic quotas. This service requires only Read & write files and Cloud Download.

Sources: [MCP connection guide](https://mypikpak.com/en-US/help-center/connected_apps/mcp/connect_ai_tool), [PAT creation](https://mypikpak.com/en-US/help-center/connected_apps/personal_access_tokens/create_personal_access_token), [protected resource metadata](https://pikpak.ai/.well-known/oauth-protected-resource/mcp), [OpenID configuration](https://user.mypikpak.com/.well-known/openid-configuration), [permissions](https://mypikpak.com/en-US/help-center/connected_apps/managing_connected_apps/connected_app_permissions) and [quota FAQ](https://mypikpak.com/en-US/connect-apps-faq).

## JSON API

Except health, session, setup and login, endpoints require an authenticated session. POST/PUT/DELETE require pp_csrf and X-CSRF-Token. Setup/login also require CSRF.

| Endpoint | Purpose |
|---|---|
| GET /healthz | Database health/version |
| GET /api/session | Setup/login status and CSRF |
| POST /api/setup | One-time password, public_url, allow_private_feeds |
| POST /api/login, /api/logout | Session lifecycle |
| GET/POST /api/subscriptions | List/create |
| PUT/DELETE /api/subscriptions/{id} | Update/delete |
| POST /api/subscriptions/{id}/check | Check new items. Backfill requires selection |
| GET /api/pikpak/folders?parent_id=…&token=… | Browse with account_ref |
| POST /api/pikpak/folders | Create with parent_id, name, account_ref |
| POST /api/subscriptions/{id}/backfill/preview | Read downloadable torrents and filenames. No queue/baseline/cloud mutations |
| POST /api/subscriptions/{id}/backfill | Confirm token and selected IDs. Atomically queue direct downloads |
| POST /api/feeds/samples | url, optional subscription_id. Metadata preview |
| POST /api/rules/preview | rule (rename_enabled, regex, replacement), filename. Shared renderer |
| GET /api/jobs, /api/jobs/{id} | Latest 200 jobs / file actions |
| POST /api/jobs | url, destination, optional destination_id/destination_account_ref. 201 queued. Repeated sources allowed |
| POST /api/jobs/{id}/retry | Resume/reconcile safely |
| DELETE /api/jobs/{id} | Cancel incomplete PikPak task, preserve files, remove local record. Optional local_only for unknown submissions without a task ID |
| DELETE /api/jobs/completed | Remove all completed records/file actions, preserve cloud files. Returns deleted count |
| GET /api/events | Last 150 entries, 30-day retention |
| GET/POST /api/settings/app | Site URL/private-feed policy |
| POST /api/settings/password | current_password, new_password, confirm_password. Revoke all sessions on success |
| GET/POST /api/settings/pikpak | Status/write-only PAT |
| POST /api/settings/pikpak/check | Reconnect |

Manual tasks detect Magnet, `.torrent` and HTTP/HTTPS links automatically. Display names use Magnet dn, torrent metadata or the URL path/host, with a resource-key fallback. Direct URLs are submitted to PikPak without fetching their content locally. Torrent URLs are resolved using the same metadata size/timeout/private-network policy as feeds. Manual tasks preserve filenames. Settings and cloud processing share a lock to prevent account switches between destination validation and queue insertion.

## Testing

Run from the repository root with Go 1.27.1, GNU Make and Node.js:

```sh
make verify
make test-race
```

`make verify` checks Go formatting, tests, vet, UI syntax/localization and the application build. Race tests require a supported C toolchain. Docker checks additionally require Docker, Compose and Buildx:

```sh
make docker-build IMAGE=pikpak-rss-manager:test
make test-container IMAGE=pikpak-rss-manager:test
make test-manifest IMAGE=ghcr.io/wade00754/pikpak-rss-manager:latest
```

Regular tests use mocks and local fixtures. Real PikPak tests are opt-in and use a PAT already configured through the Web UI. Set `PIKPAK_LIVE_DATA_DIR` if the local data directory differs from `data`. No PAT is sent to CI.

| Scope | Opt-in variable | Test |
|---|---|---|
| Folder browsing and creation | `PIKPAK_LIVE_FOLDERS_TEST=1` | `TestLiveFolderBrowsingAndCreation` |
| Direct HTTP downloads, repeated names and rename rejection | `PIKPAK_LIVE_DIRECT_TEST=1` | `TestLiveDirectDownloadAndRename` |

For example, on a POSIX shell:

```sh
PIKPAK_LIVE_DIRECT_TEST=1 go test ./tests/integration -run '^TestLiveDirectDownloadAndRename$' -count=1 -v -timeout=7m
```

Live tests create isolated fixtures inside `_pikpak-rss-manager-test/<run-id>` and preserve the cloud files. Local fixture databases use automatically cleaned temporary directories. Mocked checks do not prove real cloud behavior.

Actual validation results and untested paths are recorded in [GitHub Releases](https://github.com/wade00754/pikpak-rss-manager/releases). The [v2.0.2 validation notes](https://github.com/wade00754/pikpak-rss-manager/releases/tag/v2.0.2#validation) retain the earlier real PikPak results and their limits.
