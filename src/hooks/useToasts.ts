import { useRef, useState } from "react";

export interface ToastItem {
  id: number;
  type: "success" | "error" | "info";
  msg: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  function pushToast(type: "success" | "error" | "info", msg: string) {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, type, msg }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      4000
    );
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function dismissAll() {
    setToasts([]);
  }

  return { toasts, pushToast, dismissToast, dismissAll };
}
