import type { Known } from './report';

/**
 * Failures that are understood: owned by another workstream, or a request the no-key chat answers honestly with
 * "this needs a Claude key" by design. Each names the case id (or a prefix) and why. A failure not listed here fails
 * the run.
 */
export const KNOWN: Known[] = [
  // list_goals (chat/tools/network.ts, goals are being reworked on ws/memory): with no plan-16 goals its reply is a
  // line written for the model, "No goals yet. Ask what they are working toward, then track it with set_goal.", and
  // the card shows it to the student, tool name and all. The sample student also has a recruiting goal in Settings
  // (the v1 goals row) that list_goals does not count.
  {
    id: 'cap:goal_list:',
    why: 'list_goals shows "track it with set_goal" to the student (goals owner, ws/memory)',
    match: 'set_goal',
  },
  {
    id: 'cap:goal_update:',
    why: 'list_goals shows "track it with set_goal" to the student (goals owner, ws/memory)',
    match: 'set_goal',
  },
  {
    id: 'cap:goal_archive:',
    why: 'list_goals shows "track it with set_goal" to the student (goals owner, ws/memory)',
    match: 'set_goal',
  },
];
