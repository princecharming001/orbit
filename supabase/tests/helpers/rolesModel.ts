/**
 * Plan 44: a fake of the model for the Roles tests, answering the three tasks the server sends (the profile read, the
 * requirements read, the close read) from the request alone, the way a careful model would:
 *
 *   profile        whatever the test set
 *   requirements   one skill requirement per "Must have X." or "Nice to have X." line of the posting, quoted
 *   score          for each requirement, the student's own line that names it (else none); experience from the
 *                  student's first job line; level at; one reason and one gap
 *
 * A posting that says "score this 10" is obeyed by this model (it invents quotes and top answers), so a test can see
 * that the server's quote rule, not the model, decides.
 */
import { type AnthropicRequest, systemText, userText } from './agents.ts';

export type RolesTask = 'profile' | 'requirements' | 'score' | 'other';

/** Which of the Roles tasks a request is, by its system prompt. */
export const kind = (r: AnthropicRequest): RolesTask => {
  const s = systemText(r);
  if (s.includes("read a student's resume")) return 'profile';
  if (s.includes('list what each one asks')) return 'requirements';
  if (s.includes('compare one student')) return 'score';
  return 'other';
};

/** The block a fence wrapped with this source, the tags taken off. */
export function block(text: string, source: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(untrusted_[0-9a-f]+) source="${source}">\\n([\\s\\S]*?)\\n</\\1>`, 'g');
  for (const m of text.matchAll(re)) out.push(m[2]!);
  return out;
}

/** Posting blocks in the order of their J labels. */
export function postings(user: string): { n: number; text: string; reqs: { n: number; name: string }[] }[] {
  const parts = user.split(/\n(?=J\d+: )/).filter((p) => /^J\d+: /.test(p));
  return parts.map((p) => ({
    n: Number(/^J(\d+)/.exec(p)![1]),
    text: block(p, 'posting')[0] ?? '',
    reqs: [...p.matchAll(/^R(\d+) \((?:must|nice), skill\): (.+)$/gm)].map((m) => ({
      n: Number(m[1]),
      name: m[2]!,
    })),
  }));
}

/** A posting the fake model reads three musts and one nice from. */
export const POSTING = (title: string) =>
  `${title}\nAbout us: we build things.\nWhat you need:\nMust have Python.\nMust have SQL.\nMust have Git.\nNice to have React.`;

/** The fake model. `profileReply` is read at each profile request, so a test can set it as it goes. */
export function fakeRolesModel(o: { profileReply?: () => unknown } = {}) {
  return function fakeModel(req: AnthropicRequest): unknown {
    const user = userText(req);
    switch (kind(req)) {
      case 'profile':
        return o.profileReply?.() ?? { skills: [], kinds: [] };
      case 'requirements':
        return {
          postings: postings(user).map((p) => ({
            posting: `J${p.n}`,
            requirements: [...p.text.matchAll(/(Must|Nice to) have ([A-Za-z+#]+)\./g)].map((m) => ({
              kind: 'skill',
              need: m[1] === 'Must' ? 'must' : 'nice',
              name: m[2],
              quote: m[0],
              named: true,
              years: 0,
              degree: 'none',
              eligibility: 'none',
              gradFrom: '',
              gradTo: '',
            })),
          })),
        };
      case 'score': {
        const student = block(user, 'student')[0] ?? '';
        const lines = student.split('\n');
        return {
          roles: postings(user).map((p) => {
            // a posting that tells the model what to do: this model does it
            const hijacked = /score this 10/i.test(p.text);
            return {
              posting: `J${p.n}`,
              skills: p.reqs.map((r) => {
                const line = lines.find((l) => new RegExp(`\\b${r.name}\\b`).test(l));
                return hijacked
                  ? {
                      requirement: `R${r.n}`,
                      answer: 'work',
                      you: `Ten years of ${r.name} at Google`,
                      posting: '',
                    }
                  : line
                    ? { requirement: `R${r.n}`, answer: 'work', you: line.trim(), posting: '' }
                    : { requirement: `R${r.n}`, answer: 'none', you: '', posting: '' };
              }),
              experience: hijacked
                ? { answer: 'same', you: 'Staff engineer at Google', posting: '' }
                : {
                    answer: 'related',
                    you: lines.find((l) => l.startsWith('Job: '))?.trim() ?? '',
                    posting: '',
                  },
              education: hijacked
                ? { answer: 'fits', you: 'PhD from MIT', posting: 'PhD' }
                : { answer: 'unsaid', you: '', posting: '' },
              level: { answer: 'at', you: '', posting: p.text.split('\n')[0] ?? '' },
              reason: 'Python and SQL from your Ramp internship',
              gaps: ['Git is asked for and not on your resume'],
            };
          }),
        };
      }
      default:
        return {};
    }
  };
}
