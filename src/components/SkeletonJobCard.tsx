interface SkeletonJobCardProps {
  mediaType?: "video" | "image" | "audio";
}

export default function SkeletonJobCard({
  mediaType = "video",
}: SkeletonJobCardProps) {
  const isImage = mediaType === "image";
  const isAudio = mediaType === "audio";

  return (
    <div
      className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
      aria-hidden="true"
    >
      <div className="flex items-start gap-4">
        <div className="skeleton h-11 w-11 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="skeleton inline-block h-5 w-10 rounded-full" />
            <div className="skeleton h-4 w-48 rounded" />
          </div>
          <div className="mt-1.5 h-3 w-64 max-w-full rounded skeleton" />
        </div>
        <div className="skeleton h-8 w-8 shrink-0 rounded-lg" />
      </div>

      {isImage || !isAudio ? (
        <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-700/60">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <div className="skeleton h-3 w-12 rounded" />
              <div className="skeleton h-8 w-full rounded-lg" />
            </div>
            <div className="space-y-2">
              <div className="skeleton h-3 w-12 rounded" />
              <div className="skeleton h-8 w-full rounded-lg" />
            </div>
            <div className="space-y-2">
              <div className="skeleton h-3 w-12 rounded" />
              <div className="skeleton h-8 w-full rounded-lg" />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-700/60">
          <div className="space-y-2">
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton h-8 w-full rounded-lg" />
          </div>
        </div>
      )}
    </div>
  );
}
