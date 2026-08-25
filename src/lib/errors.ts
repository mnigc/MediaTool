type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Map a raw FFmpeg stderr string to a short, user-readable summary.
 *  The raw log is preserved separately for the "view details" view. */
export function friendlyError(
  raw: string | null | undefined,
  t: Translate
): string {
  const s = (raw ?? "").toLowerCase();

  if (!s.trim()) return t("err.friendly.empty");

  if (s.includes("invalid data found") || s.includes("moov atom not found") || s.includes("no such file") || s.includes("cannot open")) {
    return t("err.friendly.read");
  }
  if (s.includes("could not find tag for codec") || s.includes("possible to match") || s.includes("unable to find a suitable output format")) {
    return t("err.friendly.container");
  }
  if (s.includes("does not contain any stream") || s.includes("output file #0") || s.includes("zero streams")) {
    return t("err.friendly.stream");
  }
  if (s.includes("impossible to convert") || s.includes("pixel format") || s.includes("error initializing output stream")) {
    return t("err.friendly.pixfmt");
  }
  if (s.includes("device or resource busy") || s.includes("permission denied")) {
    return t("err.friendly.permission");
  }
  if (s.includes("encoder") && s.includes("not") && (s.includes("nvenc") || s.includes("qsv") || s.includes("amf") || s.includes("videotoolbox") || s.includes("vaapi"))) {
    return t("err.friendly.gpuUnavailable");
  }
  if (s.includes("no such device") || s.includes("nvenc") || s.includes("qsv") || s.includes("amf")) {
    return t("err.friendly.gpuMissing");
  }
  if (s.includes("unrecognized option") || s.includes("undefined constant")) {
    return t("err.friendly.option");
  }
  if (s.includes("out of memory") || s.includes("cannot allocate")) {
    return t("err.friendly.memory");
  }
  if (s.includes("cancel")) {
    return t("err.friendly.cancel");
  }

  return t("err.friendly.generic");
}
