/** Map a raw FFmpeg stderr string to a short, user-readable summary.
 *  The raw log is preserved separately for the "view details" view. */
export function friendlyError(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();

  if (!s.trim()) return "处理失败";

  if (s.includes("invalid data found") || s.includes("moov atom not found") || s.includes("no such file") || s.includes("cannot open")) {
    return "无法读取输入文件，文件可能已损坏、被移动或路径无效。";
  }
  if (s.includes("could not find tag for codec") || s.includes("possible to match") || s.includes("unable to find a suitable output format")) {
    return "选择的输出容器不支持当前编码器，请更换输出格式或编码器。";
  }
  if (s.includes("does not contain any stream") || s.includes("output file #0") || s.includes("zero streams")) {
    return "输出未写入任何媒体流，可能是输入流不支持该处理方式。";
  }
  if (s.includes("impossible to convert") || s.includes("pixel format") || s.includes("error initializing output stream")) {
    return "视频/音频格式转换失败，可能是像素格式或编码参数不兼容。";
  }
  if (s.includes("device or resource busy") || s.includes("permission denied")) {
    return "目标文件或输出目录被系统占用或没有写入权限。";
  }
  if (s.includes("encoder") && s.includes("not") && (s.includes("nvenc") || s.includes("qsv") || s.includes("amf") || s.includes("videotoolbox") || s.includes("vaapi"))) {
    return "当前硬件编码器不可用，请改用 CPU 处理。";
  }
  if (s.includes("no such device") || s.includes("nvenc") || s.includes("qsv") || s.includes("amf")) {
    return "硬件加速编码不可用，请检查驱动或改用 CPU。";
  }
  if (s.includes("unrecognized option") || s.includes("undefined constant")) {
    return "当前 FFmpeg 版本不支持所使用的参数或滤镜名称。";
  }
  if (s.includes("out of memory") || s.includes("cannot allocate")) {
    return "内存不足，请降低分辨率或减少并发任务数后重试。";
  }
  if (s.includes("cancel")) {
    return "任务已取消。";
  }

  // Fallback: keep it short.
  return "处理失败。";
}
