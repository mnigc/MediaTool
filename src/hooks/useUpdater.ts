import { useCallback, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "downloaded"
  | "installing";

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

  const download = useCallback(async () => {
    if (!update || busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("downloading");
    setProgress(0);
    let contentLength = 0;
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          if (contentLength > 0) {
            setProgress(
              Math.min(
                100,
                Math.round((event.data.chunkLength / contentLength) * 100)
              )
            );
          }
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setProgress(100);
      setPhase("downloaded");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      busy.current = false;
    }
  }, [update]);

  const installAndRelaunch = useCallback(async () => {
    if (!update || busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("installing");
    try {
      await update.install();
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("downloaded");
      busy.current = false;
    }
  }, [update]);

  const dismiss = useCallback(() => {
    setError(null);
  }, []);

  return {
    phase,
    update,
    progress,
    error,
    checkForUpdates,
    download,
    installAndRelaunch,
    dismiss,
  };
}
