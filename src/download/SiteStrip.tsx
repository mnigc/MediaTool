import { useI18n } from "../i18n";

/** Well-known extractors shown as a taste of yt-dlp's coverage — the real
 *  list is thousands of sites, so we show familiar names + a count. */
const SITES = [
  "YouTube",
  "Bilibili",
  "抖音 / TikTok",
  "Twitter / X",
  "Instagram",
  "Twitch",
  "微博",
  "Vimeo",
];

/** Compact "supported sites" strip under the page header. */
export default function SiteStrip({ record = false }: { record?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-xs text-neutral-400 dark:text-neutral-500">
        {t(record ? "dl.record.sites.prefix" : "dl.sites.prefix")}
      </span>
      {SITES.map((s) => (
        <span
          key={s}
          className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
        >
          {s}
        </span>
      ))}
      <span className="text-xs text-neutral-400 dark:text-neutral-500">
        {t(record ? "dl.record.sites.more" : "dl.sites.more")}
      </span>
    </div>
  );
}
