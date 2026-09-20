# MediaTool on a NAS (Docker)

Runs the headless `mediatool-server` 24/7 and serves the same web UI the
desktop app uses — the frontend is baked into the published image, nothing
to build or mount.

## Deploy it (NAS users)

```sh
cd docker
cp .env.example .env      # then edit .env
docker compose pull
docker compose up -d
docker compose exec mediatool mediatool-doctor
```

Open `http://<device-ip>:<PORT>` and enter `MEDIATOOL_TOKEN` at the gate.
In 1Panel: 容器 → 编排 → new project, paste `docker-compose.yml`, and set
the variables below in the project's `.env` editor.

**Mainland China networks** usually cannot reach Docker Hub directly. Add a
registry mirror first (1Panel: 镜像 → 镜像加速; or `registry-mirrors` in
`/etc/docker/daemon.json`), then retry the pull.

What you set in `.env`:

| Key | Meaning |
| --- | --- |
| `MEDIATOOL_TOKEN` | Access token for the UI and API. Required — the server refuses to start without it. |
| `MEDIA_LIBRARY` | Your media, mounted read-only at `/media/library`. |
| `OUTPUT_DIR` | Where finished files go, mounted writable at `/media/output`. Keep it outside the read-only mount. |
| `PORT` | Host port published (container always listens on 8787). |
| `PUBLIC_URL` | The URL your browser types, e.g. `http://192.168.1.10:8787`. Only YouTube/Google Drive/OneDrive sign-in needs it, because the provider redirects back to `<PUBLIC_URL>/oauth/callback`; register that exact URI in the provider console. Empty disables just that feature. |

## Intel Quick Sync / VAAPI

The image ships both VA-API driver generations and oneVPL, but the container
cannot see the iGPU until you hand it through. On the host:

```sh
stat -c %g /dev/dri/renderD128    # the render group GID
```

Uncomment the `devices: [/dev/dri]` and `group_add:` block in
`docker-compose.yml`, put that GID in `group_add`, then
`docker compose up -d`. Confirm with `mediatool-doctor` — it runs a real
`h264_qsv`/`hevc_qsv` encode, not a build listing. Without the passthrough
everything still works, just on the CPU.

## Engines

ffmpeg, yt-dlp and streamlink come from Debian in the image and are resolved
from `PATH`, so the in-app "install engine" buttons are not needed (and on
networks that cannot reach GitHub they would fail anyway). A refreshed
yt-dlp arrives with the next image update.

## Updating

```sh
# edit the image tag in docker-compose.yml to the new version first
docker compose pull && docker compose up -d
```

State (cookies, monitors, managed binaries) survives in the
`mediatool-data` volume across versions; to move it to another device:

```sh
docker run --rm -v mediatool-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/mediatool-data.tgz -C /data .
```

Rolling back is `docker compose down`, put the old tag back, `up -d`.

## Maintainers: how the image gets published

Pushing a `v*` tag runs both release workflows — desktop installers and this
image (`linux/amd64` only):

```sh
npm run bump 0.1.8          # rewrites every version field incl. both compose files
cargo update --workspace    # refreshes Cargo.lock
git commit -am "release: 0.1.8" && git tag v0.1.8 && git push && git push --tags
```

One-time setup in repo Settings → Secrets and variables → Actions:
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token with
read/write on the repository).

To test a Dockerfile change before shipping it, build locally from the
repo root:

```sh
docker compose -f docker/docker-compose.yml -f docker/docker-compose.build.yml up -d --build
```

The override tags the build as `mediatool:0.1.7` (or your bumped version)
and mounts `../dist` over the baked-in UI, so `npm run build` iterations
are visible on refresh without rebuilding.

## Troubleshooting

- **Gate says "Invalid token or server unreachable"** — wrong token in the
  browser, or the server never started: `docker compose logs mediatool`
  (missing `MEDIATOOL_TOKEN`/roots fail fast with a message).
- **`docker compose pull` times out** — no registry mirror configured
  (see Mainland note above), or the tag does not exist yet.
- **GPU picker shows no hardware backend** — run `mediatool-doctor`; the
  `/dev/dri` and render-group sections tell you which of the two is missing.
- **`/healthz` is green but pages fail** — check the token header reaches the
  server; a reverse proxy must forward `Authorization`.
- **Jobs fail writing to `/media/output`** — the bind mount keeps the host
  directory's ownership; the container writes as uid 10001, so either
  `chown` that onto the output dir host-side or run the container as a user
  that already owns it (`user: "1000:1000"` in compose).
- **Sign-in for YouTube/Drive/OneDrive never returns** — `PUBLIC_URL` must be
  exactly what you type in the browser, including the port.
