import { useState } from "react";
import { isDesktop } from "../lib/shell";
import { useI18n } from "../i18n";
import { useConfirm } from "../components/ConfirmDialog";
import { useUploads } from "../contexts/UploadCenter";
import Select from "../components/Select";
import { CheckCircleIcon, SpinnerIcon, TrashIcon } from "../components/icons";
import type { UploadTarget, UploadTargetKind } from "../types";

const KIND_LABEL: Record<UploadTargetKind, string> = {
  webdav: "WebDAV",
  telegram: "Telegram",
  youtube: "YouTube",
  gdrive: "Google Drive",
  onedrive: "OneDrive",
};

let draftCounter = 0;

function newTarget(kind: UploadTargetKind): UploadTarget {
  draftCounter += 1;
  const id = `target-${Date.now()}-${draftCounter}`;
  const base = { id, kind, name: "" };
  switch (kind) {
    case "webdav":
      return { ...base, kind: "webdav", url: "", username: "", password: "", directory: "", proxy: "" };
    case "telegram":
      return { ...base, kind: "telegram", botToken: "", chatId: "", proxy: "" };
    case "youtube":
      return {
        ...base,
        kind: "youtube",
        clientId: "",
        clientSecret: "",
        refreshToken: "",
        privacy: "private",
        description: "",
        proxy: "",
      };
    case "gdrive":
      return { ...base, kind: "gdrive", clientId: "", clientSecret: "", refreshToken: "", folderId: "", proxy: "" };
    case "onedrive":
      return { ...base, kind: "onedrive", clientId: "", tenant: "common", refreshToken: "", directory: "", proxy: "" };
  }
}

const inputCls =
  "min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200";

function Req() {
  return (
    <span className="mr-0.5 text-error-500" aria-hidden>
      *
    </span>
  );
}

/** Settings section: manage upload targets and the auto-upload switch. */
export default function UploadSection() {
  const { t } = useI18n();
  const uploads = useUploads();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [draft, setDraft] = useState<UploadTarget | null>(null);

  const row = "flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3";
  const labelCls = "shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300 sm:w-28";

  async function handleRemove(id: string) {
    const ok = await confirm({
      title: t("upload.settings.removeTitle"),
      message: t("upload.settings.removeMsg"),
      confirmLabel: t("confirm.delete"),
      cancelLabel: t("confirm.cancel"),
      danger: true,
    });
    if (ok) uploads.removeTarget(id);
  }

  function patchDraft(patch: Partial<UploadTarget>) {
    setDraft((d) => (d ? ({ ...d, ...patch } as UploadTarget) : d));
  }

  const isOauthDraft =
    draft?.kind === "youtube" || draft?.kind === "gdrive" || draft?.kind === "onedrive";
  const draftAuthorized =
    isOauthDraft &&
    Boolean((draft as unknown as { refreshToken?: string }).refreshToken);
  const draftClientId = draft ? (draft as unknown as { clientId?: string }).clientId ?? "" : "";
  const draftSecret = draft ? (draft as unknown as { clientSecret?: string }).clientSecret ?? "" : "";
  const oauthRunning = uploads.oauth != null && !uploads.oauth.done;

  const missingFields: string[] = [];
  if (draft) {
    if (!draft.name.trim()) missingFields.push(t("upload.settings.name"));
    if (draft.kind === "webdav" && !draft.url.trim()) missingFields.push("URL");
    if (draft.kind === "telegram") {
      if (!draft.botToken.trim()) missingFields.push("Bot Token");
      if (!draft.chatId.trim()) missingFields.push("Chat ID");
    }
    if (isOauthDraft && !draftClientId.trim()) missingFields.push("Client ID");
  }

  return (
    <section className="mt-5 rounded-2xl bg-white p-4 shadow-card ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
      <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
        {t("upload.settings.title")}
      </p>
      <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
        {t("upload.settings.subtitle")}
      </p>

      {/* target list */}
      <div className="mt-4 space-y-2">
        {uploads.targets.map((x) => (
          <div
            key={x.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-700"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {x.name}
                </span>
                <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {KIND_LABEL[x.kind]}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
                {targetSubtitle(x)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => setDraft(structuredClone(x))}
                className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {t("upload.settings.edit")}
              </button>
              <button
                onClick={() => void handleRemove(x.id)}
                className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-error-50 hover:text-error-600 dark:hover:bg-error-950/40"
                aria-label={t("upload.settings.remove")}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* add / editor */}
      {!draft ? (
        <div className="mt-3 flex items-center gap-2">
          <Select
            value=""
            onChange={(v) => {
              if (!v) return;
              setDraft(newTarget(v as UploadTargetKind));
            }}
            className="w-full sm:w-52"
            aria-label={t("upload.settings.add")}
          >
            <option value="">{t("upload.settings.add")}</option>
            {(Object.keys(KIND_LABEL) as UploadTargetKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
          <div className="space-y-3">
            <div className={row}>
              <span className={labelCls}>
                <Req />
                {t("upload.settings.name")}
              </span>
              <input
                value={draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
                placeholder={KIND_LABEL[draft.kind]}
                className={inputCls}
              />
            </div>

            {draft.kind === "webdav" && (
              <>
                <div className={row}>
                  <span className={labelCls}>
                    <Req />
                    URL
                  </span>
                  <input
                    value={draft.url}
                    onChange={(e) => patchDraft({ url: e.target.value })}
                    placeholder="https://dav.jianguoyun.com/dav/"
                    className={inputCls}
                  />
                </div>
                <div className={row}>
                  <span className={labelCls}>{t("upload.settings.username")}</span>
                  <input value={draft.username} onChange={(e) => patchDraft({ username: e.target.value })} className={inputCls} />
                </div>
                <div className={row}>
                  <span className={labelCls}>{t("upload.settings.password")}</span>
                  <input
                    type="password"
                    value={draft.password}
                    onChange={(e) => patchDraft({ password: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div className={row}>
                  <span className={labelCls}>{t("upload.settings.directory")}</span>
                  <input
                    value={draft.directory}
                    onChange={(e) => patchDraft({ directory: e.target.value })}
                    placeholder="MediaTool"
                    className={inputCls}
                  />
                </div>
              </>
            )}

            {draft.kind === "telegram" && (
              <>
                <div className={row}>
                  <span className={labelCls}>
                    <Req />
                    Bot Token
                  </span>
                  <input
                    value={draft.botToken}
                    onChange={(e) => patchDraft({ botToken: e.target.value })}
                    placeholder="123456:ABC-DEF…"
                    className={inputCls}
                  />
                </div>
                <div className={row}>
                  <span className={labelCls}>
                    <Req />
                    Chat ID
                  </span>
                  <input
                    value={draft.chatId}
                    onChange={(e) => patchDraft({ chatId: e.target.value })}
                    placeholder="@mychannel / -1001234567890"
                    className={inputCls}
                  />
                </div>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("upload.help.telegram")}</p>
              </>
            )}

            {isOauthDraft && (
              <>
                <div className={row}>
                  <span className={labelCls}>
                    <Req />
                    Client ID
                  </span>
                  <input value={draft.clientId} onChange={(e) => patchDraft({ clientId: e.target.value })} className={inputCls} />
                </div>
                {draft.kind !== "onedrive" && (
                  <div className={row}>
                    <span className={labelCls}>Client Secret</span>
                    <input
                      type="password"
                      value={draft.clientSecret}
                      onChange={(e) => patchDraft({ clientSecret: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                )}
                {draft.kind === "onedrive" && (
                  <>
                    <div className={row}>
                      <span className={labelCls}>{t("upload.settings.tenant")}</span>
                      <input value={draft.tenant} onChange={(e) => patchDraft({ tenant: e.target.value })} placeholder="common" className={inputCls} />
                    </div>
                    <div className={row}>
                      <span className={labelCls}>{t("upload.settings.directory")}</span>
                      <input value={draft.directory} onChange={(e) => patchDraft({ directory: e.target.value })} placeholder="MediaTool" className={inputCls} />
                    </div>
                  </>
                )}
                {draft.kind === "youtube" && (
                  <>
                    <div className={row}>
                      <span className={labelCls}>{t("upload.settings.privacy")}</span>
                      <Select
                        value={draft.privacy}
                        onChange={(v) => patchDraft({ privacy: v as "private" | "unlisted" | "public" })}
                        className="w-full sm:w-44"
                      >
                        <option value="private">{t("upload.settings.privacy.private")}</option>
                        <option value="unlisted">{t("upload.settings.privacy.unlisted")}</option>
                        <option value="public">{t("upload.settings.privacy.public")}</option>
                      </Select>
                    </div>
                    <div className={row}>
                      <span className={labelCls}>{t("upload.settings.description")}</span>
                      <input
                        value={draft.description}
                        onChange={(e) => patchDraft({ description: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                  </>
                )}
                {draft.kind === "gdrive" && (
                  <div className={row}>
                    <span className={labelCls}>{t("upload.settings.folderId")}</span>
                    <input
                      value={draft.folderId}
                      onChange={(e) => patchDraft({ folderId: e.target.value })}
                      placeholder={t("upload.settings.folderIdHint")}
                      className={inputCls}
                    />
                  </div>
                )}

                <p className="text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                  {!isDesktop &&
                  ["youtube", "gdrive", "onedrive"].includes(draft.kind as string)
                    ? t("upload.help.oauthWeb")
                    : t(`upload.help.${draft.kind}`)}
                </p>
                {oauthRunning && uploads.oauth && (
                  <>
                    <p className="flex items-center gap-1.5 text-xs text-brand-600 dark:text-brand-400">
                      <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                      {t("upload.oauth.waiting")} {uploads.oauth.redirectUri}
                    </p>
                    {!isDesktop && (
                      <a
                        href={uploads.oauth.authUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-brand-600 underline dark:text-brand-400"
                      >
                        {t("upload.oauth.openConsent")}
                      </a>
                    )}
                  </>
                )}
                {draftAuthorized && (
                  <p className="flex items-center gap-1.5 text-xs text-success-600 dark:text-success-400">
                    <CheckCircleIcon className="h-3.5 w-3.5" />
                    {t("upload.oauth.authorized")}
                  </p>
                )}
              </>
            )}

            <div className={row}>
              <span className={labelCls}>{t("upload.settings.proxy")}</span>
              <input
                value={draft.proxy ?? ""}
                onChange={(e) => patchDraft({ proxy: e.target.value })}
                placeholder="http://127.0.0.1:7890"
                className={inputCls}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={() => setDraft(null)}
              className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {t("confirm.cancel")}
            </button>
            {isOauthDraft && (
              <button
                onClick={() => uploads.beginOauth(draft)}
                disabled={oauthRunning || !draftClientId || (draft.kind !== "onedrive" && !draftSecret)}
                className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
              >
                {draftAuthorized ? t("upload.oauth.relogin") : t("upload.oauth.login")}
              </button>
            )}
            <button
              onClick={() => {
                if (missingFields.length > 0) return;
                uploads.saveTarget({ ...draft, name: draft.name.trim() });
                setDraft(null);
              }}
              disabled={missingFields.length > 0}
              className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-700"
            >
              {t("upload.settings.save")}
            </button>
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t("upload.settings.privacyNote")}
      </p>

      {confirmDialog}
    </section>
  );
}

function targetSubtitle(x: UploadTarget): string {
  switch (x.kind) {
    case "webdav":
      return [x.url, x.directory].filter(Boolean).join("/");
    case "telegram":
      return x.chatId;
    case "youtube":
      return x.privacy;
    case "gdrive":
      return x.folderId || "My Drive";
    case "onedrive":
      return x.directory || "OneDrive";
  }
}
