import { useCallback, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterPhase = "idle" | "checking" | "downloading" | "installing";

export const DEV_UNAVAILABLE = "DEV_MODE";

export type CheckResult =
  | { ok: true; update: Update | null }
  | { ok: false; message: string };

export function useUpdater() {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const checkForUpdates = useCallback(
    async (silent: boolean): Promise<CheckResult> => {
      if (busy.current) return { ok: false, message: "BUSY" };
      if (import.meta.env.DEV) {
        if (!silent) setError(DEV_UNAVAILABLE);
        return { ok: false, message: DEV_UNAVAILABLE };
      }
      busy.current = true;
      setPhase("checking");
      setError(null);
      try {
        const next = await check();
        if (next) {
          setUpdate(next);
          setProgress(0);
          return { ok: true, update: next };
        }
        return { ok: true, update: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return { ok: false, message: msg };
      } finally {
        busy.current = false;
        setPhase((p) => (p === "checking" ? "idle" : p));
      }
    },
    []
  );

  const downloadAndInstall = useCallback(async () => {
    if (!update || busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("downloading");
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Progress") {
          const data = event.data as {
            contentLength: number;
            chunkLength: number;
          };
          if (data.contentLength > 0) {
            setProgress(
              Math.min(100, Math.round((data.chunkLength / data.contentLength) * 100))
            );
          }
        } else if (event.event === "Finished") {
          setProgress(100);
          setPhase("installing");
        }
      });
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
      busy.current = false;
    }
  }, [update]);

  const dismiss = useCallback(() => {
    setUpdate(null);
    setError(null);
    setProgress(0);
    setPhase((p) => (p === "idle" || p === "checking" ? "idle" : p));
  }, []);

  return {
    phase,
    update,
    progress,
    error,
    checkForUpdates,
    downloadAndInstall,
    dismiss,
  };
}
