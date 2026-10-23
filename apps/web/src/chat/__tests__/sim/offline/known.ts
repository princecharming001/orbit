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
  // add_sourced with a next step reads the picked people from the search card above it in the thread ("[rec li:1]"
  // names a row of that card). On its own, with no search in the thread, the honest answer is to search again; the
  // picking flow is covered end to end in e2e/chat-pick.spec.ts and pick.test.tsx.
  {
    id: 'cap:source_add_then:',
    why: 'needs a LinkedIn search card earlier in the thread to pick from (chat-pick e2e covers the flow)',
    match: 'Search again, then pick who to add',
  },
];
