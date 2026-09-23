import { useEffect, useState } from "react";
import { mediaStreamUrl } from "../lib/shell";
import { useI18n } from "../i18n";

/** Inline playback for tools whose params are positions on the timeline.
 *  `preload="none"` with the job thumbnail as poster keeps a queue of these
 *  from spinning up a decoder per card until one is actually played. */
export default function VideoPreview({
  path,
  poster,
  className = "",
}: {
  path: string;
  poster?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setFailed(false);
    mediaStreamUrl(path)
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path]);

  if (failed) {
    return (
      <div
        className={`flex aspect-video items-center justify-center rounded-lg bg-neutral-100 px-4 text-center text-xs text-neutral-400 dark:bg-neutral-800/60 dark:text-neutral-500 ${className}`}
      >
        {t("preview.failed")}
      </div>
    );
  }

  return (
    <video
      src={src ?? undefined}
      poster={poster ?? undefined}
      controls
      preload="none"
      playsInline
      onError={() => setFailed(true)}
      className={`aspect-video w-full rounded-lg bg-black object-contain ring-1 ring-neutral-200 dark:ring-neutral-700 ${className}`}
    />
  );
}
