/** Canonical CRF tiers on the libx264 scale. Presets, download/record
 *  pipelines and tool defaults all reference these names, so "compressed",
 *  "social" etc. mean the same thing everywhere instead of scattering magic
 *  numbers that drift apart. libsvtav1 needs a higher CRF for the same file
 *  size; that one preset carries an explicit value with a comment rather
 *  than stretching this table per codec. */
export const CRF = {
  /** Visually lossless. */
  vlossless: 18,
  /** High quality archive tier. */
  high: 20,
  /** Balanced general-purpose transcode. */
  balanced: 23,
  /** Social platforms: smaller but comfortably watchable. */
  social: 26,
  /** Compact: clearly smaller files, everyday viewing. */
  compact: 28,
  /** Extreme compression. */
  extreme: 30,
} as const;
