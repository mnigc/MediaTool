/** The file name part of a Windows or POSIX path (no directory, no validation).
 *  One shared implementation — it used to be hand-rolled in five components
 *  and drifted between "split on both separators" variants. */
export function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}
