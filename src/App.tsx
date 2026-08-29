import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import Header from "./components/Header";
import ToolNav from "./components/ToolNav";
import ToastContainer from "./components/ToastContainer";
import UpdateDialog from "./components/UpdateDialog";
import { useTheme, type ThemeMode } from "./hooks/useTheme";
import { useToasts, type ToastItem } from "./hooks/useToasts";
import { useUpdater, DEV_UNAVAILABLE } from "./hooks/useUpdater";
import { useI18n } from "./i18n";
import { TaskCenterProvider } from "./contexts/TaskCenter";
import ToolWorkbench from "./tools/ToolWorkbench";
import ModulePage from "./tools/ModulePage";
import TaskPage from "./tools/TaskPage";
import PresetsPage from "./tools/PresetsPage";
import WorkflowPage from "./tools/WorkflowPage";
import { toolToModule, type Route, type WorkbenchId } from "./tools/registry";

function AppShell({
  themeMode,
  setThemeMode,
  toasts,
  dismissToast,
  onToast,
}: {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  toasts: ToastItem[];
  dismissToast: (id: number) => void;
  onToast: (type: "success" | "error" | "info", msg: string) => void;
}) {
  const [route, setRoute] = useState<Route>({ kind: "module", id: "video" });
  const { t } = useI18n();
  const { phase, update, progress, checkForUpdates, downloadAndInstall, dismiss } =
    useUpdater();
  const [currentVersion, setCurrentVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch(() => {});
    const timer = setTimeout(() => {
      checkForUpdates(true).catch(() => {});
    }, 8000);
    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  const handleCheckUpdates = useCallback(async () => {
    const result = await checkForUpdates(false);
    if (result.ok) {
      if (!result.update) onToast("success", t("updater.latest"));
      return;
    }
    if (result.message === DEV_UNAVAILABLE) {
      onToast("info", t("updater.dev"));
    } else {
      onToast(
        "error",
        result.message ? `${t("updater.failed")}: ${result.message}` : t("updater.failed")
      );
    }
  }, [checkForUpdates, t, onToast]);

  const openTool = (tool: WorkbenchId) => setRoute({ kind: "tool", tool });
  const backToModule = () => {
    setRoute((r) =>
      r.kind === "tool" ? { kind: "module", id: toolToModule(r.tool) } : r
    );
  };

  const content = () => {
    if (route.kind === "tool") {
      return <ToolWorkbench tool={route.tool} onBack={backToModule} />;
    }
    switch (route.id) {
      case "tasks":
        return <TaskPage />;
      case "presets":
        return <PresetsPage onOpenTool={openTool} />;
      case "workflow":
        return <WorkflowPage />;
      case "video":
      case "audio":
      case "image":
      case "tools":
        return <ModulePage module={route.id} onOpenTool={openTool} />;
      default:
        return <ModulePage module="video" onOpenTool={openTool} />;
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <Header
        themeMode={themeMode}
        onThemeChange={setThemeMode}
        updatePhase={phase}
        hasUpdate={update !== null}
        onCheckUpdates={handleCheckUpdates}
      />
      <div className="flex min-h-0 flex-1">
        <ToolNav route={route} onNavigate={setRoute} />
        <main className="app-main min-w-0 flex-1 overflow-y-auto p-5">
          {content()}
        </main>
      </div>
      <UpdateDialog
        open={update !== null}
        currentVersion={currentVersion}
        update={update}
        phase={phase}
        progress={progress}
        onDownload={() => downloadAndInstall().catch(() => {})}
        onClose={dismiss}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function App() {
  const { themeMode, setThemeMode } = useTheme();
  const { toasts, pushToast, dismissToast } = useToasts();

  return (
    <TaskCenterProvider onToast={pushToast}>
      <AppShell
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        toasts={toasts}
        dismissToast={dismissToast}
        onToast={pushToast}
      />
    </TaskCenterProvider>
  );
}
