import { useEffect, useRef, useState } from "react";

export interface ToastItem {
  id: number;
  type: "success" | "error" | "info";
  msg: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  // Auto-dismiss timers, kept so unmount can cancel them — otherwise a
  // timeout fires into unmounted state after the hook's owner is gone.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  function pushToast(type: "success" | "error" | "info", msg: string) {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, type, msg }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
    timers.current.add(timer);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function dismissAll() {
    setToasts([]);
  }

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, pushToast, dismissToast, dismissAll };
}
