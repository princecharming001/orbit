/**
 * Typo repair for the no-key router: a word one slip away (a swapped, missing, extra or wrong letter) from a word the
 * router's phrases use, and from no other such word, is read as that word ("piepline" -> "pipeline", "queit" ->
 * "quiet"). Names and companies are never touched, and short words are left alone, since a slip there is as likely
 * another word.
 */

/** The words the router's phrases are built from. */
const VOCAB =
  `show pipeline drafts draft follow quiet introduce introduction introductions intro routes route schedule scheduled
scheduling recommendations recommended settings notes note prep prepare message messages write send reply replied thank
congratulate congrats connections linkedin gmail google calendar today brief goals goal target targets companies company
discover remember research referral people person unsent went know meet should stage stages move undo hide snooze
dismiss approve export delete tone limits weekly warm mutual mutuals find search open chats chat check update refresh
import connect disconnect sync email emails resume profile direct formal network contacts everyone tomorrow yesterday
week month morning afternoon evening thanks please could would about with between before after again later first second
third last next done completed declined archived nurturing outreach replies response responded ghosted followup
pipeline's recruiter mentor alumni professor coffee schedule meeting meetings explain score closeness close friend
autopilot spread pause resume knows introduced sending writing drafted messaged contacted connected`
    .split(/\s+/)
    .filter(Boolean);

const WORDS = new Set(VOCAB);

/** Everyday words that sit one slip from a router word ("states" / "stages"): always read as typed. */
const COMMON = new Set(
  `what when where which while there these those their them they then than this that with from have been were will
  your yours more most some many much very just also only even still back over under does done make take give said
  tell told want need like love sure okay yeah good nice cool great idea time times days year work works role team
  help keep call calls talk talked thing things stuff else each both same such sort kind type list view page card
  cards link file text word line lines name names states state notes nodes meets sends sorry hello maybe never since
  until early think other right every being after again about would could place class lunch dinner plans shout short
  posts point points ready reads leads loads lists rates dates gets sets lets wants needs tells shows asks`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Edits between two words, counting a missing letter, an extra letter and two swapped letters as one each, and a
 * wrong letter as two: a wrong letter far more often makes another real word ("waiting" / "writing") than a slip.
 */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 2;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length]![b.length]!;
}

/** The text with each slipped word put right; `keep` holds words that must stay as typed (names, companies). */
export function fixTypos(text: string, keep: Set<string>): string {
  let first = true;
  return text.replace(/[A-Za-z']+/g, (word) => {
    const atStart = first;
    first = false;
    const w = word.toLowerCase();
    if (w.length < 4 || WORDS.has(w) || keep.has(w) || COMMON.has(w) || w.includes("'")) return word;
    // a capitalised word inside a sentence is a name ("Evercore"), never a slip
    if (!atStart && /^[A-Z]/.test(word)) return word;
    // a form of a known word ("knows", "drafted", "replies") is not a slip
    const stem = w.replace(/(?:ies|es|s|ed|ing|er|ly)$/, '');
    if (stem.length >= 3 && VOCAB.some((v) => v === stem || v.startsWith(stem) || stem.startsWith(v)))
      return word;
    const cap = w.length >= 8 ? 2 : 1;
    const hits = VOCAB.filter((v) => {
      if (Math.abs(v.length - w.length) > cap) return false;
      // slips keep the first letter, or swap the first two
      if (v[0] !== w[0] && !(v[0] === w[1] && v[1] === w[0])) return false;
      // four or five letters: only two swapped letters ("shwo", "queit")
      if (w.length <= 5) return v.length === w.length && distance(w, v, 1) === 1;
      return distance(w, v, cap) <= cap;
    });
    if (!hits.length) return word;
    const best = Math.min(...hits.map((v) => distance(w, v, cap)));
    const closest = hits.filter((v) => distance(w, v, cap) === best);
    return closest.length === 1 ? closest[0]! : word;
  });
}
