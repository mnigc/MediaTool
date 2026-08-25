import { useI18n } from "../../i18n";

export default function VideoReversePanel() {
  const { t } = useI18n();
  return (
    <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
      {t("tool.video-reverse.hint")}
    </p>
  );
}
