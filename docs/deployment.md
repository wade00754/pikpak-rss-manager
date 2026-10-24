# Deployment

## Docker / 1Panel

Use the published image and [Compose file](../docker-compose.yml). In 1Panel, create a container orchestration and paste the Compose configuration. Configure credentials through the Web UI. The service does not load `.env`.

1. Start with `docker compose up -d`.
2. Configure an HTTPS reverse proxy.
3. Open the site through a controlled connection and complete first-run setup before public access. Set the public origin, such as `https://rss.example.com`.
4. Connect the PAT in the second setup step. Then add subscriptions or manual tasks. Setup resumes after login until a PAT is verified. Existing accounts with expired PATs retain dashboard access. Update the PAT in Settings.

Only `APP_LISTEN` and `APP_DATA_DIR` remain optional process settings. Container defaults: `0.0.0.0:8080`, `/data`. Local defaults: `127.0.0.1:8080`, `data`.

## Reverse proxy

For a host proxy, use `http://127.0.0.1:8080`. For a container proxy, attach both services to the same Docker network and use `http://pikpak-rss-manager:8080`.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 130s;
}
```

Save the public origin in Settings and access the UI from that origin. Preserve Host for request validation. Cookies use Secure for HTTPS origins.

## Update

The v2.1.3 ARM64 image contains an amd64 executable and can fail with `exec format error`. Upgrade to v2.1.4 or newer, pull the image and recreate the container. Keep the existing data volume.

v2.0.0 uses direct downloads and Regex replacement only. PAT permissions are **Read & write files** and **Cloud Download**. Manage files is not required. Legacy staging, overwrite/backup, cleanup and template naming are no longer supported. Do not reuse databases containing staged jobs or template rules. No cloud content is migrated or removed. Back up the complete data volume before upgrading. Downgrades require restoring a pre-upgrade backup.

```sh
docker compose pull
docker compose up -d
docker compose logs --tail=50
```

Pin a version tag or digest to control updates. Never use `docker compose down -v` for updates. Keep the full data volume to preserve subscriptions, encrypted PATs and direct jobs.

## Backup / restore

Stop the service and back up the entire volume, including `manager.db`, WAL/SHM files and `secret.key`. The database contains encrypted PATs and private URLs. Losing the key makes them unrecoverable.

```sh
docker compose stop
docker volume ls
docker run --rm -v <actual-volume-name>:/data:ro -v "$PWD":/backup \
  alpine:3.23 tar -czf /backup/pikpak-rss-backup.tar.gz -C /data .
docker compose start
```

To restore, stop the service, extract the full backup into its data volume, set ownership to `65532:65532`, and restart. Protect the backup and key. Named volumes inherit the image's /data ownership. Bind mounts require matching host permissions.

## Password recovery

Open **Forgot password** on the login page. In the server terminal, create a one-time recovery code:

```sh
docker compose exec pikpak-rss-manager /app/pikpak-rss-manager recovery-code
```

For a local installation, run `pikpak-rss-manager recovery-code` with the same `APP_DATA_DIR` as the running service. The command requires the existing database and encryption key. It does not stop the service or reopen first-run setup.

Enter the code and a new password on the recovery page. The code expires after 15 minutes. Creating another code replaces the previous one. Resetting the password ends all sessions while retaining subscriptions, tasks, site settings and the saved PikPak PAT. If you cannot access the server, contact its administrator.

## Image publishing

Actions validates tests, race detection, vet, Docker startup and persistence, then publishes amd64/arm64 images on main/tag pushes using GITHUB_TOKEN. Release tags must match `cmd/pikpak-rss-manager/VERSION`.

For forks, update the Compose image and source labels. Set the GHCR package to Public after its first publication and verify anonymous pulls. Public repository visibility does not make a package public.
