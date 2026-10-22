/**
 * A role read from a LinkedIn headline. Only the headline's first part says where someone works ("Product @ Google |
 * Growing Ads for SMBs at scale" works at Google, not at "scale"): the parts after a bar or a dot are what they do.
 */
const PARTS = /\s+[|·•]\s+|\s+[–—-]\s+/;
const AT = /^(.+?)\s+(?:at|@)\s*(.+)$|^(.+?)\s*@\s*(.+)$/i;

export function roleFromHeadline(headline: string | undefined): { title?: string; org?: string } {
  const first = headline?.trim().split(PARTS)[0]?.trim();
  if (!first) return {};
  const m = AT.exec(first);
  if (!m) return { title: first.length <= 80 ? first : undefined };
  const title = (m[1] ?? m[3])!.trim().replace(/[,;]$/, '');
  const org = (m[2] ?? m[4])!
    .trim()
    .replace(/\s*\(.*\)$/, '')
    .replace(/[.,;!]+$/, '');
  return { title: title || undefined, org: org || undefined };
}
