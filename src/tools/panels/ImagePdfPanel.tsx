import { useI18n } from "../../i18n";

export default function ImagePdfPanel() {
  const { t } = useI18n();
  return (
    <p className="text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
      {t("tool.image-pdf.hint")}
    </p>
  );
}
