/**
 * Words about the reply buttons themselves ("The options are below.", "I can't post anything after those buttons").
 * The pills sit under the answer unannounced, so a sentence that only points at them, or explains how they work, is
 * the assistant talking about its own interface: it is never shown, live or when the chat is opened again.
 */
const BUTTON_TALK =
  /\b(?:buttons?|pills|options|choices)\b[^.?!\n]*\b(?:below|above|under (?:this|here|my (?:message|answer|reply))|end (?:the|my) (?:reply|turn|message)|after (?:them|those|these))\b|\b(?:put up|added|left you)\b[^.?!\n]*\b(?:buttons?|pills|(?:quick )?options|choices)\b|\b(?:post|write|say) anything after\b/i;

/** A short sentence whose point is the buttons. */
export function isButtonTalk(sentence: string): boolean {
  const s = sentence.trim();
  return !!s && s.length <= 160 && BUTTON_TALK.test(s);
}

/** Where the next sentence ends: a stop followed by a space, or a line break. A stop at the very end waits. */
const SENTENCE_END = /[.?!]+["')\]]*(?=\s)\s*|\n+/;

/** The text without its sentences about the buttons, everything else exactly as written. */
export function withoutButtonTalk(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const m = SENTENCE_END.exec(rest);
    if (!m) break;
    const end = m.index + m[0].length;
    const sentence = rest.slice(0, end);
    if (!isButtonTalk(sentence)) out += sentence;
    rest = rest.slice(end);
  }
  if (!isButtonTalk(rest)) out += rest;
  return out;
}

/**
 * The live text, a sentence at a time: each sentence goes out once it ends, unless it is about the buttons. `flush`
 * sends what is left at the end of a message.
 */
export function sentenceGate(emit: (text: string) => void): {
  push: (delta: string) => void;
  flush: () => void;
} {
  let held = '';
  return {
    push(delta) {
      held += delta;
      for (;;) {
        const m = SENTENCE_END.exec(held);
        if (!m) return;
        const end = m.index + m[0].length;
        const sentence = held.slice(0, end);
        held = held.slice(end);
        if (!isButtonTalk(sentence)) emit(sentence);
      }
    },
    flush() {
      const rest = held;
      held = '';
      if (rest && !isButtonTalk(rest)) emit(rest);
    },
  };
}
