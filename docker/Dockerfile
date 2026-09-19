# syntax=docker/dockerfile:1

# ── Build ─────────────────────────────────────────────────────────────
# Only mediatool-server is compiled: the workspace also holds the Tauri
# desktop package, but building a single member never runs its build
# script, so the image needs none of the GTK/webkit toolchain.
FROM rust:1-slim-trixie AS build
WORKDIR /src

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release -p mediatool-server


# ── Runtime ───────────────────────────────────────────────────────────
FROM debian:trixie-slim AS runtime

LABEL org.opencontainers.image.title="MediaTool" \
      org.opencontainers.image.description="Local media toolbox, headless server for NAS deployment"

# ffmpeg, yt-dlp and streamlink all come from Debian rather than the
# in-app installers, because those reach for GitHub and fail on networks
# that cannot see it. The engine resolves each of them from PATH, so no
# configuration is needed to pick these up.
#
# The Intel packages are the QSV/VA-API stack: iHD (intel-media-va-driver
# -non-free) for Gen8+ and the older i965 driver for pre-Skylake, plus
# both oneVPL runtimes. Installing both families is deliberate — the
# right set depends on the iGPU generation, which is unknown at build
# time, and an unused driver costs nothing at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tzdata \
      ffmpeg \
      yt-dlp \
      streamlink \
      python3 \
      intel-media-va-driver-non-free \
      i965-va-driver \
      libmfx-gen1.4 \
      libmfx1 \
      libvpl2 \
      libvpl-tools \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# The render group of the host, granted through compose's `group_add`, is
# what actually lets this user open /dev/dri/renderD128.
RUN useradd --system --create-home --shell /usr/sbin/nologin --uid 10001 mediatool

COPY --from=build /src/target/release/mediatool-server /usr/local/bin/mediatool-server
COPY docker/doctor.sh /usr/local/bin/mediatool-doctor
RUN chmod +x /usr/local/bin/mediatool-doctor

ENV MEDIATOOL_LISTEN=0.0.0.0:8787 \
    MEDIATOOL_DATA=/data \
    MEDIATOOL_ROOTS=/media \
    MEDIATOOL_STATIC=/srv/web \
    RUST_LOG=info

VOLUME ["/data"]
EXPOSE 8787

# `mediatool` alone has no render-group membership, so QSV only works when
# compose adds the host group. Drop back to root if that is unacceptable on
# your device — see docker-compose.yml.
USER mediatool

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent "http://127.0.0.1:${MEDIATOOL_LISTEN##*:}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/mediatool-server"]
