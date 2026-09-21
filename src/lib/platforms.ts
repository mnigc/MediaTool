/** Sites we can name. An unmapped room keeps its bare host: inventing a
 *  friendly label for an extractor we don't know would mislead more than a
 *  domain does. Keys are registrable domains, matched the same way the
 *  backend matches per-platform cookies (exact or as a parent domain). */
const PLATFORMS: { host: string; key: string }[] = [
  { host: "douyin.com", key: "platform.douyin" },
  { host: "tiktok.com", key: "platform.tiktok" },
  { host: "bilibili.com", key: "platform.bilibili" },
  { host: "huya.com", key: "platform.huya" },
  { host: "douyu.com", key: "platform.douyu" },
  { host: "kuaishou.com", key: "platform.kuaishou" },
  { host: "twitch.tv", key: "platform.twitch" },
  { host: "youtube.com", key: "platform.youtube" },
  { host: "kick.com", key: "platform.kick" },
  { host: "nicovideo.jp", key: "platform.nicolive" },
  { host: "weibo.com", key: "platform.weibo" },
];

/** The host a room URL belongs to — the same authority the backend keys
 *  per-platform cookies on, so the label and the cookies never diverge. */
export function roomHost(url: string): string {
  const afterScheme = url.split("://")[1] ?? url;
  const authority = afterScheme.split(/[/?#]/)[0];
  if (!authority || authority.includes("@") || authority.startsWith("[")) return "";
  return authority.replace(/:\d+$/, "").replace(/\.+$/, "").replace(/^www\./i, "").toLowerCase();
}

export function platformLabel(url: string, t: (key: string) => string): string {
  const host = roomHost(url);
  if (!host) return "";
  const known = PLATFORMS.find((p) => host === p.host || host.endsWith(`.${p.host}`));
  return known ? t(known.key) : host;
}
