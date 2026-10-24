# Architecture and API

One Go process, one administrator, one active PikPak account and one SQLite data volume. Vite builds the React frontend into `internal/web/ui/dist`. Go embeds that output in a single binary. Node is a build dependency, with no Node runtime or local media transfer.

The frontend uses React 19, strict TypeScript and Vite, scaffolded with `npm create rail`. Shared React components own form fields, checkbox fields, information popovers, dialogs, PAT entry, styled selects, appearance controls and settings navigation. One Radix-based Select component owns the trigger, themed options, Lucide selection indicators, focus-visible ring and keyboard navigation for language and torrent filenames. Menus stay within the owning dialog or popover layer. All interface glyphs use Lucide through the shared Icon component, with a consistent two-pixel stroke and inherited theme colors. Action labels contain text only. The shared PikPak RSS wordmark uses locally bundled bold Inter, with white text in dark mode and theme ink in light mode. Product text and controls share Inter, with fallback fonts for Chinese glyphs. Labels remain adjacent to controls and information triggers preserve label height. Controlled settings fields retain edits when switching categories. Requests use the existing authenticated JSON API and CSRF token. Source/folder reads and debounced naming previews are cancelled when their components close or inputs change.

Folder creation dialogs render outside the subscription and manual-download forms. Creating a folder never submits the parent draft. Native cancel and close events apply only to their owning dialog. Dismissing a child preserves the parent draft and its discard guard.

Accepted subscription and manual-download saves close the draft before refreshing the workspace. Refresh failures appear in workspace feedback and cannot re-enable an accepted create request.

Go `html/template` renders only the initial page and version attributes in Vite's HTML entry. React retrieves session state before exposing management flows. Development uses a loopback Vite server with an API proxy. Production serves fingerprinted assets under `/ui/`. Docker builds the frontend in a Node stage and embeds it in the Go stage.

| Module | Responsibility |
|---|---|
| frontend | React components, styles, language catalog and UI tests |
| internal/web | Embedded frontend, sessions, CSRF and API |
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

Backfill preview reads one RSS snapshot and each distinct torrent URL once, with bounded concurrency and metadata/output budgets. Session/account-bound plans expire after 15 minutes. The backfill panel can select or clear all available torrents, with a partial-selection checkbox state. Rows with metadata errors are excluded. Selection resets when the panel opens and freezes after confirmation so explicit retries keep the same token and torrent IDs. Confirmations validate the subscription and destination again, then atomically queue whole torrents using stable job IDs.

## Limits and security

PAT requires Read & write files and Cloud Download. The MCP adapter has no move, Trash or permanent-deletion operations. Jobs do not create staging, backup or attachment folders, scan destination differences, overwrite or clean cloud content. Manual destination paths can create their explicitly named folders. SQLite migrations remain, but staged-job and template-rule compatibility is removed.

- Feed/torrent metadata: 2 MiB per resource. Full sample reads: one feed snapshot, each distinct torrent once, at most five concurrent requests, 32 MiB total metadata, 10,000 filenames/8 MiB output, 90-second overall and 15-second torrent timeouts. Partial successes are retained.
- Enabling renaming loads torrent filenames automatically after a valid RSS URL settles for 500 ms. The refresh icon rereads metadata while retaining the selected filename. Regex edits update only the naming preview, without rereading the feed.
- Preview reads metadata only. It does not submit tasks or change baselines. The shared renderer returns raw_name, normalized name and warnings.
- Selected folder IDs carry opaque account references. The server revalidates IDs/account ownership. Folder creation is sent once. Uncertain results require review.
- First-run UI: administrator creation, then PAT connection. Authenticated users without a saved or connected account resume the connection step. Saved accounts retain the dashboard when authorization expires. Connection errors appear in Settings.
- First-run password: nonempty, salted Argon2id verifier. PATs/private URLs: AES-GCM with a persistent secret.key. Credentials are never returned or logged. No external password/PAT sources or .env loading.
- Password recovery requires server access. The `recovery-code` command issues a random 256-bit, one-use code valid for 15 minutes. Only its digest, expiry and bound administrator verifier are stored in an encrypted setting. Recovery atomically consumes the code and replaces its bound verifier. A regular password change invalidates outstanding codes. Successful recovery revokes all sessions and preserves site settings and cloud credentials.
- Sessions: 12 hours, memory only. Mutations require matching CSRF cookie/header and same-origin checks. HTTP-only/SameSite cookies, login throttling and CSP are enabled.
- The workspace fills the available width and places RSS subscriptions on the left and offline tasks on the right, with a subscription/task switch on mobile. The dashboard fills the viewport. Each list scrolls independently beneath its section heading. Failure explanations appear in task details. Task rows open details across their full area and support native button keyboard activation, with a subtle hover background and visible focus outline. Task and subscription cards share a row component, full-row activation and hover styling. Subscription cards use rounded solid surfaces with gaps and borders. Task sections have bordered surfaces. Both use their full row to open details. A shared WorkspacePanel component gives both panels a fixed header row and an inset, independently scrolling list. Dashboard layout rules live in workspace.css with shared spacing and optical-control alignment tokens. Desktop uses a two-column grid and mobile switches panels. Status-section headings have equal heights and align with the leading task icons. Tasks show a colored Lucide status icon and filename followed by time. Active tasks share a download icon, attention states share a circle-alert icon and completed tasks use a circle-check icon. The full status appears in accessible button names and task details. Panel labels are RSS 訂閱 and 下載任務; task sections are 需要處理, 進行中 and 已完成, and the profile menu is labelled 帳號與設定. All labels have English equivalents. Tasks appear in attention, active and completed sections, in red, purple and green order. Each section sorts newest first. All returned tasks appear by default, and a secondary brush icon at the right of the Completed section heading clears completed local records while retaining cloud files. Task details lead with status, destination and state-specific recovery actions. Files requiring attention appear first, with completed files and internal IDs collapsed. The header contains the wordmark, a global next-RSS-check indicator, a storage meter and the account menu; its padded profile trigger shows a filled circular avatar with the first character of the account name. The account name appears inside the menu. Dashboard data refreshes every 15 seconds while visible and no dialog is open. The RSS indicator uses the earliest enabled subscription schedule and shows due, paused or no-active-subscription states. Only its Lucide refresh icon is a button, with a 44-pixel target, keyboard activation, a focus-visible outline and a countdown description. It checks the current enabled feeds sequentially through the existing check endpoint, then refreshes dashboard data. Header icons center beside each text-and-bar group. The RSS and storage icons share 44px containers, 20px glyphs and the same gap to their labels. RSS and storage use matching continuous bars beneath their labels. Empty bars remain visible when storage is unavailable, RSS is paused or no subscriptions are enabled. Unavailable bars have descriptive accessible labels without reporting zero usage. Pending checks disable repeated activation and show loading feedback. A failed feed does not block checks of other feeds, and expired sessions stop the batch. Downloading rows show reported percentage beside a circular progress meter at the far right, centered vertically. In narrower task panels, progress shares the title line without increasing its height and metadata spans the remaining row width. Other task states retain their status icons without estimated download progress. Storage accepts byte strings and the official account_info display values such as GB and TB. Display values retain their official units, and percentages use unit-aware comparisons. Derived percentages and free space are approximate when the provider returns rounded display values. Storage reads are cached for one minute and bounded to five seconds, with concurrent readers using the last snapshot. Failed reads retain the last successful values and timestamp without changing worker state. Account switches discard responses from the previous connection. Each section has a labelled plus icon for adding a task or subscription, including empty workspaces. Subscription and task metadata share a dot-separated row component. Subscriptions show destination, last-check time and check interval. Tasks show filename and creation time, with download progress in a separate trailing area when available. Both text lines inherit the body size, with weight and muted color carrying the hierarchy. A purple Lucide FileSymlink icon marks each subscription and a right-aligned play/pause control changes tracking directly, preserving the saved feed, destination and naming settings. Paused cards use 0.6 opacity and restore the control to full opacity on hover or keyboard focus. Clicking subscription cards opens settings with sections for subscription details, naming rules and management. Management contains checking, inline backfill selection and confirmed deletion. The shared settings sidebar keeps drafts mounted across section changes, and form validation reveals hidden invalid fields before saving. Editing an existing subscription preserves its tracking state. The account menu opens Settings and Logs in dialogs and contains theme, language and sign-out controls. Settings navigation switches between PikPak authorization, site settings and password settings while retaining unsaved form values. Shared dialog guards confirm discarding changed drafts, and unchanged forms disable saving. Save actions align at the bottom of settings sections. Closing dialogs returns focus to their opener, with an account-menu fallback when it is unavailable. Tracking operations show loading only on the affected subscription and keep other cards usable. Setup and login retain their header controls.
- UI language is a browser preference. Only application literals and message fields are translated. Names, paths, URLs, regex and filenames remain intact.
- Light and dark themes share CSS color tokens. Purple marks actions and active tasks. Green marks connected/completed states. Red marks attention, errors and delete actions. Completed-record cleanup uses the secondary action style. Filename previews use neutral colors. Source filenames and replacement results share a monospace font, left edge and framed field style, with labels above each value. Successful preview loads omit the filename count. Loading, empty-source, failure and metadata-limit notices remain visible. Form errors use prominent red text.

## Authentication

PAT authentication is implemented. Create a token through PikPak and enter it in Settings. Replace it before expiry. The service stores the bearer token encrypted with AES-GCM.

OAuth is researched only. Discovery checked on 2026-10-03 advertised authorization code, PKCE S256, refresh tokens and client registration. Registration, callbacks, consent and refresh flows have not been implemented or tested. Discovery declarations do not prove those flows will succeed for this service.

The permission documentation reviewed at that time restricted permanent deletion and invitations through both PAT and hosted MCP. OAuth does not automatically unlock them. Connected apps share monthly traffic quotas. This service requires only Read & write files and Cloud Download.

Sources: [MCP connection guide](https://mypikpak.com/en-US/help-center/connected_apps/mcp/connect_ai_tool), [PAT creation](https://mypikpak.com/en-US/help-center/connected_apps/personal_access_tokens/create_personal_access_token), [protected resource metadata](https://pikpak.ai/.well-known/oauth-protected-resource/mcp), [OpenID configuration](https://user.mypikpak.com/.well-known/openid-configuration), [permissions](https://mypikpak.com/en-US/help-center/connected_apps/managing_connected_apps/connected_app_permissions) and [quota FAQ](https://mypikpak.com/en-US/connect-apps-faq).

## JSON API

Except health, session, setup, login and password recovery, endpoints require an authenticated session. POST/PUT/DELETE require pp_csrf and X-CSRF-Token. Setup, login and recovery also require CSRF. Recovery additionally requires the server-issued one-time code.

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
| POST /api/password/recovery | Server-issued code, new_password, confirm_password. Consume code and revoke sessions |
| POST /api/settings/password | current_password, new_password, confirm_password. Revoke all sessions on success |
| GET/POST /api/settings/pikpak | Status with storage_used, storage_total and storage_updated_at / write-only PAT |
| POST /api/settings/pikpak/check | Reconnect |

Manual tasks detect Magnet, `.torrent` and HTTP/HTTPS links automatically. Display names use Magnet dn, torrent metadata or the URL path/host, with a resource-key fallback. Direct URLs are submitted to PikPak without fetching their content locally. Torrent URLs are resolved using the same metadata size/timeout/private-network policy as feeds. Manual tasks preserve filenames. Settings and cloud processing share a lock to prevent account switches between destination validation and queue insertion.

## Testing

Run from the repository root with Go 1.27.1, GNU Make and Node.js 24 with npm:

```sh
make verify
make test-race
```

`make verify` checks Go formatting, Go tests/vet, React types/lint/formatting/component tests, and the application build. Race tests require a supported C toolchain. Docker checks additionally require Docker, Compose and Buildx:

```sh
make docker-build IMAGE=pikpak-rss-manager:test
make test-container IMAGE=pikpak-rss-manager:test
make test-manifest IMAGE=ghcr.io/wade00754/pikpak-rss-manager:latest
```

Regular tests use mocks and local fixtures. Real PikPak tests are opt-in and use a PAT already configured through the Web UI. Set `PIKPAK_LIVE_DATA_DIR` if the local data directory differs from `data`. No PAT is sent to CI.

Container checks compare the executable's ELF architecture with the image platform. CI, publication validation and anonymous-pull smoke tests run containers on native amd64 and arm64 runners. This catches mislabeled binaries that emulation can otherwise conceal.

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
