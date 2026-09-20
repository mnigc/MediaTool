#!/bin/sh
# MediaTool container self-check.
#
# The QSV stack depends on the iGPU generation and on how /dev/dri is passed
# through, neither of which can be verified at image build time. Run this on
# the NAS to find out what the container can actually do:
#
#     docker compose exec mediatool mediatool-doctor
#
# Everything here is read-only apart from a touch test in the data dir.

status=0

section() { printf '\n== %s ==\n' "$1"; }
ok()   { printf '  [ok]   %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; status=1; }
note() { printf '  [note] %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

section "identity"
id
if ! id -nG | tr ' ' '\n' | grep -qx "$(stat -c '%G' /dev/dri/renderD128 2>/dev/null || echo NOGROUP)"; then
    note "current user is not in the render group; QSV/VA-API will fail"
    note "add the host group to compose:  group_add: [\"$(stat -c '%g' /dev/dri/renderD128 2>/dev/null || echo '<gid>')\"]"
fi

section "engines on PATH"
for tool in ffmpeg ffprobe yt-dlp streamlink python3; do
    if have "$tool"; then
        v=$("$tool" -version 2>&1 | head -1)
        ok "$tool -> $(command -v "$tool")  ($v)"
    else
        bad "$tool not found in PATH"
    fi
done

section "/dev/dri"
if [ -e /dev/dri/renderD128 ]; then
    ls -l /dev/dri | sed 's/^/  /'
else
    bad "/dev/dri/renderD128 is missing — pass the GPU in with devices: [/dev/dri]"
fi

section "hardware encoders (real encode, not a build listing)"
probe() {
    label="$1"; shift
    if out=$(ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i "color=c=black:s=256x256:d=0.1" "$@" -f null - 2>&1); then
        ok "$label"
    else
        bad "$label: $(printf '%s' "$out" | head -1)"
    fi
}
probe "h264_qsv  (Intel Quick Sync)" -c:v h264_qsv
probe "hevc_qsv  (Intel Quick Sync)" -c:v hevc_qsv
probe "h264_vaapi (VAAPI)" -vaapi_device /dev/dri/renderD128 -vf format=nv12,hwupload -c:v h264_vaapi
note "the server runs the same test at startup; what it reports in the GPU"
note "picker is what this section shows, not what ffmpeg was compiled with"

section "configuration"
for var in MEDIATOOL_LISTEN MEDIATOOL_DATA MEDIATOOL_ROOTS MEDIATOOL_RESOURCES MEDIATOOL_STATIC; do
    eval "value=\${$var:-}"
    if [ -n "$value" ]; then ok "$var=$value"; else note "$var is unset"; fi
done
if [ -z "${MEDIATOOL_TOKEN:-}" ]; then
    bad "MEDIATOOL_TOKEN is unset — the server refuses to start without it"
else
    ok "MEDIATOOL_TOKEN is set (${#MEDIATOOL_TOKEN} chars)"
fi
if [ -z "${MEDIATOOL_PUBLIC_URL:-}" ]; then
    note "MEDIATOOL_PUBLIC_URL is unset — YouTube/Drive/OneDrive sign-in cannot"
    note "come back to the app (the provider would redirect to a loopback"
    note "address inside this container). Set it in .env to the URL you type in"
    note "the browser; every other feature works without it."
else
    ok "OAuth callback: ${MEDIATOOL_PUBLIC_URL%/}/oauth/callback — register this"
    ok "one verbatim as the redirect URI in the Google/Microsoft console"
fi

section "web ui"
web=${MEDIATOOL_STATIC:-/srv/web}
if [ -f "$web/index.html" ]; then
    ok "$web/index.html is present — the server will serve the UI at /"
else
    bad "$web/index.html is missing — rebuild the image (the frontend is baked in since 0.1.7)"
fi

section "writability"
data=${MEDIATOOL_DATA:-/data}
if touch "$data/.mediatool-doctor" 2>/dev/null; then
    rm -f "$data/.mediatool-doctor"
    ok "$data is writable"
else
    bad "$data is not writable by $(id -un)"
fi

for root in $(printf '%s' "${MEDIATOOL_ROOTS:-}" | tr ',;' '  '); do
    if [ -r "$root" ]; then
        ok "$root is readable"
    else
        bad "$root is not readable — check the volume mount"
    fi
done

section "result"
if [ "$status" -eq 0 ]; then
    printf '  all checks passed\n'
else
    printf '  some checks failed (see [FAIL] lines above)\n'
fi
exit "$status"
