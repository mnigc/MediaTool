import { useEffect, useState } from "react";
import Header from "./components/Header";
import ToolNav from "./components/ToolNav";
import ToastContainer from "./components/ToastContainer";
import WebGate from "./components/WebGate";
import { FileBrowserProvider } from "./components/FileBrowser";
import { appVersion, revealWindow } from "./lib/shell";
import { useTheme, type ThemeMode } from "./hooks/useTheme";
import { useToasts, type ToastItem } from "./hooks/useToasts";
import { useUpdater } from "./hooks/useUpdater";
import { TaskCenterProvider } from "./contexts/TaskCenter";
import { DownloadCenterProvider } from "./contexts/DownloadCenter";
import { UploadCenterProvider } from "./contexts/UploadCenter";
import { PipelineCenterProvider } from "./contexts/PipelineCenter";
import ToolWorkbench from "./tools/ToolWorkbench";
import ModulePage from "./tools/ModulePage";
import TaskPage from "./tools/TaskPage";
import PresetsPage from "./tools/PresetsPage";
import WorkflowPage from "./tools/WorkflowPage";
import DownloadPage from "./download/DownloadPage";
import RecordPage from "./download/RecordPage";
import SettingsPage from "./tools/SettingsPage";
import AboutPage from "./tools/AboutPage";
import { MODULES, toolToModule, type Route, type WorkbenchId } from "./tools/registry";

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
  // Land on the first sidebar entry (下载), not a hardcoded module id.
  const [route, setRoute] = useState<Route>({ kind: "module", id: MODULES[0] });
  const updater = useUpdater();
  const { checkForUpdates } = updater;
  const [currentVersion, setCurrentVersion] = useState("");

  useEffect(() => {
    appVersion()
      .then(setCurrentVersion)
      .catch(() => {});
    const timer = setTimeout(() => {
      checkForUpdates(true).catch(() => {});
    }, 8000);
    return () => clearTimeout(timer);
  }, [checkForUpdates]);

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
        return <WorkflowPage onOpenTasks={() => setRoute({ kind: "module", id: "tasks" })} />;
      case "download":
        return (
          <DownloadPage onOpenSettings={() => setRoute({ kind: "module", id: "settings" })} />
        );
      case "record":
        return (
          <RecordPage onOpenSettings={() => setRoute({ kind: "module", id: "settings" })} />
        );
      case "settings":
        return <SettingsPage themeMode={themeMode} onThemeChange={setThemeMode} />;
      case "about":
        return (
          <AboutPage currentVersion={currentVersion} updater={updater} onToast={onToast} />
        );
      case "video":
      case "audio":
        return <ModulePage module={route.id} onOpenTool={openTool} />;
      default:
        return <ModulePage module="video" onOpenTool={openTool} />;
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <ToolNav route={route} onNavigate={setRoute} />
        <main className="app-main min-w-0 flex-1 overflow-y-auto p-5">
          {content()}
        </main>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function App() {
  const { themeMode, setThemeMode } = useTheme();
  const { toasts, pushToast, dismissToast } = useToasts();

  useEffect(() => {
    // Reveal the hidden window once the first frame is painted (Rust has a
    // 5s fallback timer in case this never runs).
    const raf = requestAnimationFrame(() => revealWindow());
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <WebGate>
      <FileBrowserProvider>
        <UploadCenterProvider onToast={pushToast}>
          <TaskCenterProvider onToast={pushToast}>
            <PipelineCenterProvider>
              <DownloadCenterProvider>
                <AppShell
                  themeMode={themeMode}
                  setThemeMode={setThemeMode}
                  toasts={toasts}
                  dismissToast={dismissToast}
                  onToast={pushToast}
                />
              </DownloadCenterProvider>
            </PipelineCenterProvider>
          </TaskCenterProvider>
        </UploadCenterProvider>
      </FileBrowserProvider>
    </WebGate>
  );
}
