import type { Job, JobParams } from "../types";
import JobCard from "./JobCard";
import { useI18n } from "../i18n";

interface JobListProps {
  jobs: Job[];
  onJobStart: (uiId: string) => void;
  onJobCancel: (uiId: string) => void;
  onJobRemove: (uiId: string) => void;
  onJobOpenFolder: (path: string) => void;
  onJobChangeParams: (uiId: string, params: JobParams) => void;
  onJobSyncParams?: (uiId: string) => void;
  onJobRetry: (uiId: string) => void;
  onReorderStart: (uiId: string) => void;
  onReorderOver: (uiId: string) => void;
  onReorderDrop: (uiId: string) => void;
}

export default function JobList({
  jobs,
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
  const { t } = useI18n();
  return (
    <div
      data-od-id="job-list"
      id="job-list"
      className="space-y-3"
      role="list"
      aria-label={t("a11y.taskList")}
    >
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
