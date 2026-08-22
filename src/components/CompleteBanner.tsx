import { CheckIcon } from "./icons";
import { formatBytes } from "../lib/tauri";

interface CompleteBannerProps {
  totalJobs: number;
  overallSavings: number;
  totalIn: number;
  totalOut: number;
}

export default function CompleteBanner({
  totalJobs,
  overallSavings,
  totalIn,
  totalOut,
}: CompleteBannerProps) {
  return (
    <div className="mt-6 flex items-center gap-3 rounded-2xl bg-brand-500 px-5 py-4 text-white shadow-lg shadow-brand-200/50">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/20">
        <CheckIcon className="h-6 w-6" />
      </span>
      <div>
        <div className="text-sm font-semibold">全部完成</div>
        <div className="text-xs text-brand-100">
          共 {totalJobs} 个任务 · 节省 {(overallSavings * 100).toFixed(0)}% 空间
          （{formatBytes(totalIn - totalOut)}）
        </div>
      </div>
    </div>
  );
}
