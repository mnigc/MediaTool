import { FolderIcon, XIcon } from "./icons";

interface SettingsBarProps {
  outputDir: string | null;
  outputSuffix: string;
  onChooseOutput: () => void;
  onSetOutputSuffix: (value: string) => void;
  onClearOutputDir: () => void;
}

export default function SettingsBar({
  outputDir,
  outputSuffix,
  onChooseOutput,
  onSetOutputSuffix,
  onClearOutputDir,
}: SettingsBarProps) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
      <FolderIcon className="h-4 w-4 text-brand-500" />
      <span>输出到</span>
      <span className="max-w-[260px] truncate font-medium text-neutral-700 dark:text-neutral-300">
        {outputDir ?? "与源文件相同目录"}
      </span>
      <button
        onClick={onChooseOutput}
        className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
      >
        更改
      </button>
      {outputDir && (
        <button
          onClick={onClearOutputDir}
          className="rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          title="重置为源目录"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <span className="ml-1 text-neutral-400 dark:text-neutral-500">
        文件名后缀
      </span>
      <input
        value={outputSuffix}
        onChange={(e) => onSetOutputSuffix(e.target.value)}
        placeholder="_mediapress"
        className="w-28 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 shadow-sm transition focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:focus:border-brand-500 dark:focus:ring-brand-900/50"
      />
    </div>
  );
}
