import type { PersonFact } from '../types';

/**
 * Facts that answer the same question differently ("She grew up in Pittsburgh" and "She grew up in Chicago", or two
 * different teams she leads). Notes from different chats, or a misheard dictation, can disagree; the profile points
 * at both so the student deletes the wrong one instead of a draft quoting it.
 */
const SLOTS: [string, RegExp][] = [
  ['hometown', /\b(?:grew up in|is from|was raised in|comes from|hometown is)\s+(.+)/i],
  ['lives', /\b(?:lives in|is based in|moved to)\s+(.+)/i],
  ['leads', /\b(?:leads|runs|heads|manages)\s+(?:the\s+)?(.+?)\s+(?:team|group|org|organization)\b/i],
  ['team', /\b(?:works on|is on)\s+(?:the\s+)?(.+?)\s+(?:team|group)\b/i],
  ['school', /\b(?:studied at|went to|graduated from)\s+(.+)/i],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\b(the|a|an|and|in|at|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** For each fact that disagrees with another one about the same person, the text of the one it disagrees with. */
export function conflictingFacts(
  facts: Pick<PersonFact, 'id' | 'text' | 'deletedAt'>[],
): Map<string, string> {
  const bySlot = new Map<string, { id: string; text: string; value: string }[]>();
  for (const f of facts) {
    if (f.deletedAt) continue;
    for (const [slot, re] of SLOTS) {
      const m = f.text.match(re);
      if (!m?.[1]) continue;
      // the first words of the answer are what differs ("Pittsburgh, near the river" and "Pittsburgh" agree)
      const value = norm(m[1]).split(' ').slice(0, 3).join(' ');
      if (!value) continue;
      const list = bySlot.get(slot) ?? [];
      list.push({ id: f.id, text: f.text, value });
      bySlot.set(slot, list);
      break;
    }
  }
  const out = new Map<string, string>();
  for (const list of bySlot.values())
    for (const a of list) {
      const other = list.find(
        (b) => b.id !== a.id && !b.value.startsWith(a.value) && !a.value.startsWith(b.value),
      );
      if (other) out.set(a.id, other.text);
    }
  return out;
}
