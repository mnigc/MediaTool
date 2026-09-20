# syntax=docker/dockerfile:1

# ── Web frontend ──────────────────────────────────────────────────────
# The same Vite bundle the desktop app ships, built in the image so the
# container is self-contained: mediatool-server serves it at MEDIATOOL_STATIC.
# `tsc && vite build` needs no Tauri runtime — @tauri-apps/cli is only an
# npm platform package here and is never invoked.
FROM node:24-slim AS web
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY src ./src
RUN npm run build


# ── Rust build ────────────────────────────────────────────────────────
# Only mediatool-server is compiled: the workspace also holds the Tauri
# desktop package, but building a single member never runs its build
# script, so the image needs none of the GTK/webkit toolchain.
FROM rust:1-slim-trixie AS build
WORKDIR /src

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

COPY . .
# Cache mounts keep the registry index and the target tree between builds, so
# a rebuild after a small change recompiles incrementally rather than from
# zero — first build is still the slow one.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release -p mediatool-server \
 && cp /src/target/release/mediatool-server /usr/local/bin/mediatool-server


# ── Runtime ───────────────────────────────────────────────────────────
FROM debian:trixie-slim AS runtime

LABEL org.opencontainers.image.title="MediaTool" \
      org.opencontainers.image.description="Local media toolbox, headless server for NAS deployment"

# ffmpeg comes from Debian rather than the in-app installer, because that
# reaches for GitHub and fails on networks that cannot see it. The engine
# resolves it from PATH, so no configuration is needed to pick it up.
# yt-dlp and streamlink are the exceptions: site extractors break within
# weeks (Bilibili answers stale releases with HTTP 412), and Debian's
# packages lag months, so both are baked from their canonical sources — the
# image build runs on GitHub Actions where those are reachable, and each
# image release then ships whatever is current.
#
# The Intel packages are the QSV/VA-API stack: iHD (intel-media-va-driver
# -non-free) for Gen8+ and the older i965 driver for pre-Skylake, plus the
# oneVPL dispatcher (libvpl2) and the GPU runtime it loads. Installing both
# driver families is deliberate — the right set depends on the iGPU
# generation, which is unknown at build time, and an unused driver costs
# nothing at runtime.
#
# Only intel-media-va-driver-non-free lives in the non-free component, which
# the slim images do not enable by default. The package names are
# trixie-specific: the GPU runtime soname dropped from libmfx-gen1.4
# (bookworm) to libmfx-gen1.2, and the Media SDK dispatcher libmfx1 is gone
# entirely, so these lines break the moment the base image moves.
RUN sed -i 's/^Components: .*/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tzdata \
      ffmpeg \
      python3 \
      python3-pip \
      intel-media-va-driver-non-free \
      i965-va-driver \
      libmfx-gen1.2 \
      libvpl2 \
      libvpl-tools \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Standalone build bundles its own Python; amd64-only, matching the
# platforms list in .github/workflows/docker-publish.yml.
RUN curl -fsSL --retry 3 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version

# PyPI is streamlink's canonical source (no standalone Linux binary exists);
# the site plugins — including the former plugin collection — ship inside
# the main package, so updating it refreshes them too.
RUN pip3 install --no-cache-dir --break-system-packages -U streamlink \
 && streamlink --version

# The render group of the host, granted through compose's `group_add`, is
# what actually lets this user open /dev/dri/renderD128.
RUN useradd --system --create-home --shell /usr/sbin/nologin --uid 10001 mediatool

# Copied out of the build stage's /usr/local/bin because the target/ cache
# mount above hides the build tree from cross-stage COPY.
COPY --from=build /usr/local/bin/mediatool-server /usr/local/bin/mediatool-server
COPY --from=web /app/dist /srv/web
COPY docker/doctor.sh /usr/local/bin/mediatool-doctor
# Workspace checkouts on Windows carry CRLF (core.autocrlf=true); a \r after
# the shebang would make the script unrunnable inside the container.
RUN sed -i 's/\r$//' /usr/local/bin/mediatool-doctor \
 && chmod +x /usr/local/bin/mediatool-doctor

ENV MEDIATOOL_LISTEN=0.0.0.0:8787 \
    MEDIATOOL_DATA=/data \
    MEDIATOOL_ROOTS=/media \
    MEDIATOOL_STATIC=/srv/web \
    RUST_LOG=info

# A named volume is initialised from this directory, so its ownership has to
# be set here or the first mount belongs to root and uid 10001 cannot write.
RUN mkdir -p /data && chown mediatool:mediatool /data

VOLUME ["/data"]
EXPOSE 8787

# `mediatool` alone has no render-group membership, so QSV only works when
# compose adds the host group. Drop back to root if that is unacceptable on
# your device — see docker-compose.yml.
USER mediatool

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent "http://127.0.0.1:${MEDIATOOL_LISTEN##*:}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/mediatool-server"]
