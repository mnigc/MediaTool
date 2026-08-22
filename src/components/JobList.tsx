import type { Job, JobParams } from "../types";
import JobCard from "./JobCard";

interface JobListProps {
  jobs: Job[];
  maxConcurrent: number;
  onMaxConcurrentChange: (n: number) => void;
  onJobStart: (uiId: string) => void;
  onJobCancel: (uiId: string) => void;
  onJobRemove: (uiId: string) => void;
  onJobOpenFolder: (path: string) => void;
  onJobChangeParams: (uiId: string, params: JobParams) => void;
  onJobSyncParams: (uiId: string) => void;
  onJobRetry: (uiId: string) => void;
  onReorderStart: (uiId: string) => void;
  onReorderOver: (uiId: string) => void;
  onReorderDrop: (uiId: string) => void;
}

export default function JobList({
  jobs,
  maxConcurrent,
  onMaxConcurrentChange,
  onJobStart,
  onJobCancel,
  onJobRemove,
  onJobOpenFolder,
  onJobChangeParams,
  onJobSyncParams,
  onJobRetry,
  onReorderStart,
  onReorderOver,
  onReorderDrop,
}: JobListProps) {
  return (
    <div
      data-od-id="job-list"
      id="job-list"
      className="space-y-3"
      role="list"
      aria-label="任务列表"
    >
      <input
        type="range"
        min="1"
        max="4"
        step="1"
        value={maxConcurrent}
        onChange={(e) => onMaxConcurrentChange(Number(e.target.value))}
        className="sr-only"
        aria-label="并行度"
      />
      {jobs.map((job, idx) => (
        <JobCard
          key={job.uiId}
          job={job}
          startIndex={idx}
          onStart={onJobStart}
          onCancel={onJobCancel}
          onRemove={onJobRemove}
          onOpenFolder={onJobOpenFolder}
          onChangeParams={onJobChangeParams}
          onSyncParams={onJobSyncParams}
          onRetry={onJobRetry}
          onReorderStart={onReorderStart}
          onReorderOver={onReorderOver}
          onReorderDrop={onReorderDrop}
        />
      ))}
    </div>
  );
}
