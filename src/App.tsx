import { useState } from "react";
import Header from "./components/Header";
import ToolNav from "./components/ToolNav";
import TaskDock from "./components/TaskDock";
import ToastContainer from "./components/ToastContainer";
import { useTheme, type ThemeMode } from "./hooks/useTheme";
import { useToasts, type ToastItem } from "./hooks/useToasts";
import { TaskCenterProvider } from "./contexts/TaskCenter";
import ToolWorkbench from "./tools/ToolWorkbench";
import type { WorkbenchId } from "./tools/registry";

function AppShell({
  themeMode,
  setThemeMode,
  toasts,
  dismissAll,
}: {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  toasts: ToastItem[];
  dismissAll: () => void;
}) {
  const [activeTool, setActiveTool] = useState<WorkbenchId>("video-compress");

  return (
    <div className="flex h-screen flex-col">
      <Header themeMode={themeMode} onThemeChange={setThemeMode} />
      <div className="flex min-h-0 flex-1">
        <ToolNav active={activeTool} onChange={setActiveTool} />
        <main className="app-main min-w-0 flex-1 overflow-y-auto p-5">
          <ToolWorkbench tool={activeTool} />
        </main>
      </div>
      <TaskDock />
      <ToastContainer toasts={toasts} onDismiss={dismissAll} />
    </div>
  );
}

export default function App() {
  const { themeMode, setThemeMode } = useTheme();
  const { toasts, pushToast, dismissAll } = useToasts();

  return (
    <TaskCenterProvider onToast={pushToast}>
      <AppShell
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        toasts={toasts}
        dismissAll={dismissAll}
      />
    </TaskCenterProvider>
  );
}
