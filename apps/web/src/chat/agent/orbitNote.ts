/**
 * Orbit's own notes to the model ("[Orbit] Your reply had no answer in words..."): stored as user-role rows so the
 * history replays exactly, but never something the student said. A reopened chat must not draw them as the
 * student's bubbles, and the title, memory and the router must not read them as the student's words.
 */
export const ORBIT_NOTE = '[Orbit]';

/** A row of the student's role whose words are Orbit's, not the student's. */
export function isOrbitNote(m: { role: string; content: unknown }): boolean {
  if (m.role !== 'user' && m.role !== 'system') return false;
  const first =
    typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content[0] : undefined;
  const text =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && (first as { type?: string }).type === 'text'
        ? String((first as { text?: unknown }).text ?? '')
        : '';
  return text.trimStart().startsWith(ORBIT_NOTE);
}

/** A text block that is Orbit's note, not the student's words (one can follow their words in the same message). */
export const isOrbitText = (text: string) => text.trimStart().startsWith(ORBIT_NOTE);
