/**
 * The words of an automated warm-up: which of a person's recent posts to engage with, and the one comment the student
 * will leave on it. Written once, by the light model, before the start sheet is shown; the student reads it there,
 * edits it or leaves it out, and what they approve is what is posted. Nothing here runs after Start.
 *
 * A comment is one or two sentences about that post (a real question, or one added point), in the student's voice,
 * with no praise, no ask, no link and no tag. A draft that breaks those rules is not offered: the sheet then asks the
 * student to write their own or leave the comment out. Without Claude the first candidate post is used and no comment
 * is drafted.
 */
import {
  postExcerpt,
  tidyWarmUpComment,
  WARMUP_AUTO_CAPS,
  type WarmUpPostCandidate,
  warmUpCommentProblems,
} from '@orbit/core/warmup/auto';
import { z } from 'zod/v4';
import { type Claude, makeFence } from '../claude.ts';

export const WARMUP_COMMENT_PROMPT_VERSION = 'warmup-comment-v1';
/** How much of each post the writer reads. */
export const POST_CHARS = 1500;
/** How much about the student the writer reads. */
export const STUDENT_CHARS = 1500;
/** The longest drafted comment, in words (the student may write more). */
export const DRAFT_MAX_WORDS = 45;

const schema = z.object({
  /** which post, by its number in <posts> (1 is the first) */
  post: z.number().int(),
  /** what the post is about, in at most eight words, as it would follow "your post about" */
  topic: z.string(),
  comment: z.string(),
});

export interface WarmupWords {
  post: WarmUpPostCandidate;
  excerpt: string;
  /** what the post is about, for the first message later; unset when nothing named it */
  topic?: string;
  /** the drafted comment; unset when none was written or the draft broke the rules */
  comment?: string;
  /** why there is no comment: no writer, the writer failed or refused, or its draft was not usable */
  commentNote?: 'no_writer' | 'writer_failed' | 'not_usable';
}

export function warmupCommentSystem(first: string, rule: string): string {
  return [
    `You help ${first} warm up to someone on LinkedIn before writing to them. Pick one of that person's recent posts and write the one comment ${first} will leave on it, as themselves. ${first} reads the comment before it is posted.`,
    'Pick the post a thoughtful stranger could add to: one that makes a point or tells of something they did. Not a job advert, a reshared link, or a personal announcement such as a birthday, a wedding or a loss.',
    'The comment:',
    `- one or two sentences, at most ${DRAFT_MAX_WORDS} words;`,
    '- about something this post says: a real question about it, or one added point. It must make no sense under any other post;',
    '- no praise and no thanks (never "great post", "love this", "inspiring", "insightful", "thanks for sharing"), no flattery adjectives;',
    `- asks for nothing (no call, chat, referral or look at a profile) and never says ${first} wants to connect or will be in touch;`,
    `- claims nothing about ${first} that is not in <student>; when unsure, ask a question instead of stating an experience;`,
    '- plain words, sentence case, no hashtags, no emoji, no links, no @ mentions, no em dashes, no exclamation marks;',
    '- matches <voice> for contractions and sentence length.',
    'Also give the topic of the post you picked in at most eight words, lower case, as it would follow "your post about" (for example "onboarding new analysts in their first week").',
    rule,
  ].join('\n');
}

/**
 * The post to engage with and the comment to offer. `candidates` come from `warmUpPostCandidates`, best first, and are
 * never empty here.
 */
export async function writeWarmupWords(
  claude: Pick<Claude, 'configured' | 'structured'>,
  o: {
    userId: string;
    studentFirstName: string;
    /** who the student is, in a few lines */
    student: string;
    /** the voice card as text (compose/context.ts voiceText) */
    voice: string;
    personName: string;
    personHeadline?: string | null;
    candidates: WarmUpPostCandidate[];
  },
): Promise<WarmupWords> {
  const first = o.candidates[0]!;
  const plain = (c: WarmUpPostCandidate, note?: WarmupWords['commentNote']): WarmupWords => ({
    post: c,
    excerpt: postExcerpt(c.text),
    ...(note ? { commentNote: note } : {}),
  });
  if (!claude.configured) return plain(first, 'no_writer');
  const fence = makeFence();
  const posts = o.candidates
    .map((c, i) => fence.wrap(`post ${i + 1}`, c.text.replace(/\s+\n/g, '\n').slice(0, POST_CHARS)))
    .join('\n');
  const r = await claude.structured({
    task: 'warmup_comment',
    system: warmupCommentSystem(o.studentFirstName, fence.rule),
    user: [
      `<student>\n${o.student.slice(0, STUDENT_CHARS)}\n</student>`,
      `<voice>\n${o.voice}\n</voice>`,
      fence.wrap('person', [o.personName, o.personHeadline ?? ''].filter(Boolean).join(', ')),
      `<posts>\n${posts}\n</posts>`,
    ].join('\n'),
    schema,
    userId: o.userId,
  });
  if (!r.ok) return plain(first, 'writer_failed');
  const picked = o.candidates[r.data.post - 1] ?? first;
  const topic = r.data.topic
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(your post )?about\s+/i, '')
    .replace(/[.\s]+$/, '');
  const comment = tidyWarmUpComment(r.data.comment);
  const words = comment.split(/\s+/).filter(Boolean).length;
  const usable =
    warmUpCommentProblems(comment).length === 0 &&
    words <= DRAFT_MAX_WORDS * 2 &&
    comment.length <= WARMUP_AUTO_CAPS.commentMaxChars;
  return {
    post: picked,
    excerpt: postExcerpt(picked.text),
    ...(topic && topic.split(/\s+/).length <= 12 ? { topic } : {}),
    ...(usable ? { comment } : { commentNote: 'not_usable' as const }),
  };
}
