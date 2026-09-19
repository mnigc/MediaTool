import { useI18n } from "../i18n";

/** Well-known extractors shown as a taste of yt-dlp's coverage — the real
 *  list is thousands of sites, so we show familiar names + a count. */
const DOWNLOAD_SITES = [
  "YouTube",
  "Bilibili",
  "抖音 / TikTok",
  "Twitter / X",
  "Instagram",
  "Twitch",
  "微博",
  "Vimeo",
];

/** Recording is handed to streamlink when it's installed (see
 *  `ytdlp::run_download_blocking`), and streamlink does not fall back to
 *  yt-dlp for URLs it has no plugin for — so this list mirrors streamlink's
 *  plugins (~155), not yt-dlp's extractors. Twitter/Instagram/微博 lives
 *  would fail there, so they stay download-only. */
const RECORD_SITES = [
  "YouTube",
  "Twitch",
  "Bilibili",
  "抖音 / TikTok",
  "斗鱼",
  "虎牙",
  "Kick",
  "NicoLive",
];

/** Compact "supported sites" line under the page header. Plain text (not
 *  pills): these names are informational — pill styling would imply they
 *  are clickable filters. */
export default function SiteStrip({ record = false }: { record?: boolean }) {
  const { t } = useI18n();
  const sites = record ? RECORD_SITES : DOWNLOAD_SITES;
  return (
    <p className="min-w-0 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
      {t(record ? "dl.record.sites.prefix" : "dl.sites.prefix")}
      {" "}
      <span className="text-neutral-600 dark:text-neutral-300">
        {sites.join(" · ")}
      </span>{" "}
      {t(record ? "dl.record.sites.more" : "dl.sites.more")}
    </p>
  );
}
