/**
 * Portraits for the made-up people of the demo and the landing page. Every face in public/demo-faces is generated,
 * not a photo of anyone (see public/demo-faces/LICENSE.md). A first name has a few faces; the people who share it
 * take them in the order they appear, so no two people in one network wear the same face.
 */

/** How many faces each first name has: files `<name>-1.webp` to `<name>-<n>.webp`. */
const FACES: Record<string, number> = {
  aisha: 4,
  alina: 3,
  amara: 7,
  arjun: 4,
  ava: 1,
  ben: 1,
  caleb: 1,
  chloe: 1,
  clara: 1,
  daniel: 1,
  diego: 3,
  elena: 4,
  ethan: 1,
  felix: 5,
  freya: 1,
  grace: 5,
  hannah: 1,
  ines: 2,
  isabel: 4,
  jade: 1,
  jonah: 1,
  jordan: 3,
  kai: 1,
  keiko: 6,
  kenji: 3,
  leila: 4,
  lena: 1,
  lila: 1,
  lucas: 1,
  marcus: 4,
  mateo: 4,
  maya: 1,
  mei: 4,
  nina: 4,
  noah: 1,
  olivia: 1,
  omar: 1,
  priya: 5,
  ravi: 4,
  rhea: 1,
  ruth: 1,
  sam: 1,
  sana: 4,
  sebastian: 4,
  sofia: 1,
  tara: 1,
  theo: 1,
  tom: 1,
  tomas: 3,
  victor: 1,
  yuki: 4,
  zara: 3,
};

const url = (file: string) => `${import.meta.env.BASE_URL}demo-faces/${file}.webp`;

/** The demo student's own portrait. */
export const DEMO_STUDENT_FACE = url('alex-rivera');

/** The face for the `nth` person (1-based) with this first name, or undefined when the name has none. */
export function demoFace(firstName: string | undefined, nth = 1): string | undefined {
  const key = (firstName ?? '').trim().toLowerCase();
  const n = FACES[key];
  if (!n) return undefined;
  return url(`${key}-${((Math.max(1, nth) - 1) % n) + 1}`);
}

/** Gives each person without a photo a face, in order. Returns the same people, updated in place. */
export function withDemoFaces<T extends { firstName?: string; photoUrl?: string }>(people: T[]): T[] {
  const seen = new Map<string, number>();
  for (const p of people) {
    const key = (p.firstName ?? '').toLowerCase();
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    p.photoUrl ??= demoFace(p.firstName, nth);
  }
  return people;
}
