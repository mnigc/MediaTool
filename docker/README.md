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
If you manage containers with a web panel (1Panel, Portainer, a NAS vendor
suite), create a compose project from this file and set the variables below
in its `.env` editor — the steps are the same.

**Networks that cannot reach Docker Hub directly** (common in Mainland
China): the quickest fix is to pull the same image through a public mirror
by adding its prefix to the image name — edit `image:` in
`docker-compose.yml`, e.g.

```yaml
image: docker.1ms.run/gwakcho/mediatool:latest
```

then `docker compose up -d`. Only the download source changes; everything
else is identical. Public mirrors come and go — if one fails, try another
prefix, or set up a `registry-mirrors` list in `/etc/docker/daemon.json`
(most mirrors today only work as a name prefix, not through
`registry-mirrors`). Last resort: `docker save`/`load` a tarball from any
machine that can reach Docker Hub.

What you set in `.env`:

| Key | Meaning |
| --- | --- |
| `MEDIATOOL_TOKEN` | Access token for the UI and API. Required — the server refuses to start without it. |
| `MEDIA_LIBRARY` | Your media, mounted read-only at `/media/library`. |
| `OUTPUT_DIR` | Where finished files go, mounted writable at `/media/output`. Keep it outside the read-only mount. |
| `PORT` | Host port published (container always listens on 8787). |
| `PUBLIC_URL` | The URL your browser types, e.g. `http://192.168.1.10:8787`. Only YouTube/Google Drive/OneDrive sign-in needs it, because the provider redirects back to `<PUBLIC_URL>/oauth/callback`; register that exact URI in the provider console. To use it, also uncomment `MEDIATOOL_PUBLIC_URL` in `docker-compose.yml`. |

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

ffmpeg comes from Debian and is resolved from `PATH`, so the in-app "install
engine" button is not needed (and on networks that cannot reach GitHub it
would fail anyway). yt-dlp and streamlink are baked into the image from their
canonical sources (GitHub releases / PyPI) at build time, so each image ships
a current version; site extractors change fast, and refreshed engines arrive
with the next image update (`docker compose pull`).

## Updating

The compose file tracks `gwakcho/mediatool:latest`, so updating is just:

```sh
docker compose pull && docker compose up -d
```

State (cookies, monitors, managed binaries) survives in the
`mediatool-data` volume across versions; to move it to another device:

```sh
docker run --rm -v mediatool-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/mediatool-data.tgz -C /data .
```

To pin a version (or roll back), put the tag in `image:` — every release is
also published as `gwakcho/mediatool:<version>` — then `up -d`.

## Troubleshooting

- **Gate says "Invalid token or server unreachable"** — wrong token in the
  browser, or the server never started: `docker compose logs mediatool`
  (missing `MEDIATOOL_TOKEN`/roots fail fast with a message).
- **`docker compose pull` times out** — no mirror configured (see the
  mirror note above; try a different prefix), or the tag does not exist yet.
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

---

# MediaTool NAS 部署（Docker·中文版）

以无界面模式 7×24 运行 `mediatool-server`，并提供与桌面应用相同的 Web UI
——前端已烘焙进发布镜像，无需构建或挂载任何文件。

## 部署（NAS 用户）

```sh
cd docker
cp .env.example .env      # 然后编辑 .env
docker compose pull
docker compose up -d
docker compose exec mediatool mediatool-doctor
```

浏览器打开 `http://<设备IP>:<PORT>`，在进门页输入 `MEDIATOOL_TOKEN`。
若你用 Web 面板管理容器（1Panel、Portainer、NAS 厂商自带套件等），
基于本文件新建一个编排项目，在其 `.env` 编辑器里设置下面这些变量即可，
步骤相同。

**无法直连 Docker Hub 的网络**（中国大陆常见）：最快的办法是给镜像名加公共
加速前缀——修改 `docker-compose.yml` 的 `image:`，例如：

```yaml
image: docker.1ms.run/gwakcho/mediatool:latest
```

然后 `docker compose up -d`。这只改变下载来源，容器行为完全一致。公共加速
站时常更替——一个不通就换另一个前缀，或改在 `/etc/docker/daemon.json` 里配
`registry-mirrors`（注意如今多数加速站只支持名字前缀方式，不支持
`registry-mirrors`）。实在不行：在任何能访问 Docker Hub 的机器上
`docker save` 成 tar 包，拷贝到 NAS `docker load`。

`.env` 中需要设置的变量：

| 键 | 含义 |
| --- | --- |
| `MEDIATOOL_TOKEN` | UI 和 API 的访问令牌。必填——没有它服务器拒绝启动。 |
| `MEDIA_LIBRARY` | 你的媒体库，以只读方式挂载到 `/media/library`。 |
| `OUTPUT_DIR` | 成品文件的输出目录，以可写方式挂载到 `/media/output`。必须放在只读挂载之外。 |
| `PORT` | 宿主机发布的端口（容器内始终监听 8787）。 |
| `PUBLIC_URL` | 浏览器地址栏里输入的那个 URL，例如 `http://192.168.1.10:8787`。只有 YouTube/Google Drive/OneDrive 登录需要它，因为服务商会把浏览器重定向回 `<PUBLIC_URL>/oauth/callback`，需在服务商控制台登记完全一致的 URI。要用它还需取消 `docker-compose.yml` 里 `MEDIATOOL_PUBLIC_URL` 一行的注释。 |

## Intel 核显加速（Quick Sync / VAAPI）

镜像已内置两代 VA-API 驱动和 oneVPL，但若不手动透传，容器看不到核显。
在宿主机上执行：

```sh
stat -c %g /dev/dri/renderD128    # 得到 render 组的 GID
```

取消 `docker-compose.yml` 里 `devices: [/dev/dri]` 和 `group_add:` 两块的
注释，把该 GID 填入 `group_add`，然后 `docker compose up -d`。
用 `mediatool-doctor` 确认——它会跑一次真实的 `h264_qsv`/`hevc_qsv` 编码，
而不是只看编译列表。不做透传一切照常运行，只是全部走 CPU。

## 引擎

ffmpeg、yt-dlp 和 streamlink 来自镜像内的 Debian 软件源，从 `PATH` 解析，
因此应用内的"安装引擎"按钮不需要（在无法访问 GitHub 的网络上它们本来也会
失败）。更新版的 yt-dlp 会随下一次镜像更新到来。

## 更新

compose 默认跟随 `gwakcho/mediatool:latest`，因此更新只需：

```sh
docker compose pull && docker compose up -d
```

状态数据（cookies、监控任务、托管二进制）保存在 `mediatool-data` 卷中，
跨版本保留；要迁移到另一台设备：

```sh
docker run --rm -v mediatool-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/mediatool-data.tgz -C /data .
```

要锁定版本（或回滚），把 `image:` 改成具体 tag 再 `up -d`——每个发布版本
同时以 `gwakcho/mediatool:<版本号>` 推送。

## 故障排查

- **进门页提示"Invalid token or server unreachable"** — 浏览器里的令牌不对，
  或服务器根本没启动：`docker compose logs mediatool`
  （缺少 `MEDIATOOL_TOKEN`/roots 时会立即报错退出并给出提示）。
- **`docker compose pull` 超时** — 未配置加速（见上文镜像加速说明；换一个前缀
  再试），或该 tag 尚未发布。
- **GPU 选择器里没有硬件后端** — 运行 `mediatool-doctor`，其输出中
  `/dev/dri` 和 render 组两节能告诉你是缺了哪一个。
- **`/healthz` 正常但页面失败** — 检查令牌请求头是否到达服务器；反向代理
  必须转发 `Authorization`。
- **任务写入 `/media/output` 失败** — bind 挂载会保留宿主机目录的所属权；
  容器以 uid 10001 写入，因此在宿主机上把输出目录 `chown` 给它，或让容器
  以一个已经拥有该目录的用户运行（compose 里加 `user: "1000:1000"`）。
- **YouTube/Drive/OneDrive 登录后一直不返回** — `PUBLIC_URL` 必须与浏览器
  地址栏输入的完全一致，包括端口。
