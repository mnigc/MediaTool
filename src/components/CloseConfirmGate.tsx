//! Listens for the backend's `close-confirm` event — raised when the user
//! closes the window (X, Alt+F4, tray quit) while jobs / downloads / live
//! recordings are active — and asks for confirmation before really exiting.

import { useEffect } from "react";
import { isDesktop, type UnlistenFn } from "../lib/shell";
import { appExit, onCloseConfirm } from "../lib/engine";
import { useI18n } from "../i18n";
import { useConfirm } from "./ConfirmDialog";

export default function CloseConfirmGate() {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void onCloseConfirm((tasks) => {
      const items = [
        tasks.jobs ? t("closeConfirm.jobs", { count: tasks.jobs }) : "",
        tasks.downloads
          ? t("closeConfirm.downloads", { count: tasks.downloads })
          : "",
        tasks.recordings
          ? t("closeConfirm.recordings", { count: tasks.recordings })
          : "",
      ].filter(Boolean);
      void confirm({
        title: t("closeConfirm.title"),
        message: t("closeConfirm.message", {
          items: items.join(t("closeConfirm.joiner")),
        }),
        confirmLabel: t("closeConfirm.exit"),
        danger: true,
      }).then((ok) => {
        if (ok) void appExit();
      });
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [confirm, t]);

  return dialog;
}
