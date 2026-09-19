import { useCallback, useEffect, useState, type ReactNode } from "react";
import { hasToken, isDesktop, onUnauthorized, setToken } from "../lib/shell";
import { fsRoots } from "../lib/engine";
import { useI18n } from "../i18n";
import { Button, inputCls } from "./ui";
import { LogoIcon, SpinnerIcon } from "./icons";

/**
 * Token gate for the browser build.
 *
 * The server holds no session of its own: every call and the event socket
 * carry a bearer token, which is the shared secret the operator set as
 * `MEDIATOOL_TOKEN`. Nothing below this gate mounts until the token has been
 * accepted, because a half-authenticated app would fire twenty commands that
 * each fail with 401.
 */
export default function WebGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"checking" | "ready" | "rejected">(() =>
    isDesktop ? "ready" : "checking"
  );

  const verify = useCallback(async () => {
    try {
      await fsRoots();
      setPhase("ready");
    } catch {
      // Either the token is wrong or the server is not there; the gate cannot
      // tell them apart, and the remedy (check the address, retype it) is the
      // same from the user's side.
      setPhase("rejected");
    }
  }, []);

  useEffect(() => {
    if (phase === "checking") void verify();
  }, [phase, verify]);

  useEffect(() => {
    // A token revoked or rotated server-side has to bring the gate back down
    // while the app is open, not just on the next reload.
    return onUnauthorized(() => setPhase(isDesktop ? "ready" : "rejected"));
  }, []);

  if (phase === "ready") return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-6 dark:bg-neutral-950">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get("token");
          if (typeof value === "string" && value.trim()) {
            setToken(value);
            setPhase("checking");
          }
        }}
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-popover ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700"
      >
        <div className="flex items-center gap-3">
          <LogoIcon className="h-9 w-9" />
          <div className="leading-tight">
            <div className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              MediaTool
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("web.gate.subtitle")}
            </div>
          </div>
        </div>

        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">{t("web.gate.desc")}</p>
        <input
          autoFocus
          name="token"
          type="password"
          autoComplete="off"
          placeholder={t("web.gate.placeholder")}
          className={`${inputCls} mt-3 w-full`}
        />
        {phase === "rejected" && (
          <p className="mt-2 text-xs text-error-500">{t("web.gate.rejected")}</p>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={phase === "checking" && hasToken()}
          className="mt-5 w-full"
        >
          {phase === "checking" ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t("web.gate.checking")}
            </>
          ) : (
            t(hasToken() ? "web.gate.retry" : "web.gate.enter")
          )}
        </Button>
      </form>
    </div>
  );
}
