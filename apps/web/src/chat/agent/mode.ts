import { describeLlmFailure, llmEnabled, overDailyCap } from '../../integrations/anthropic';
import { readPrefs } from '../../integrations/prefs';

export const SETTINGS_ROUTE = '/settings/integrations';

/** What the no-key router can and cannot do, in the student's words. Shown as the first bubble and in the footer. */
export const ROUTER_ABILITIES =
  'It can show your day, pipeline, people, drafts and routes, move chats, add notes and start template drafts, and it still asks before anything is sent. It cannot answer free-form questions, rewrite messages in your voice or reason about what to do next.';

/**
 * 'llm' when a Claude key is saved, the chat feature is on and today's budget is not used up; 'router' otherwise.
 * Read from the in-memory prefs: callers refresh them first when another tab may have changed them.
 */
export function chatMode(): 'llm' | 'router' {
  return llmEnabled('chat') && !overDailyCap() ? 'llm' : 'router';
}

/** Why the mode is 'router', in one plain sentence with the settings route to fix it; undefined in 'llm' mode. */
export function chatModeNote(): { text: string; href?: string } | undefined {
  const p = readPrefs();
  if (!p.anthropicApiKey)
    return {
      text: `Without a Claude key, Orbit understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Add your own key in Settings, Integrations to chat freely; it stays on this device.`,
      href: SETTINGS_ROUTE,
    };
  if (!llmEnabled('chat'))
    return {
      text: `Chat with Claude is turned off, so Orbit understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Turn it on in Settings, Integrations to chat freely.`,
      href: SETTINGS_ROUTE,
    };
  const cap = overDailyCap();
  if (cap) {
    const { title, body } = describeLlmFailure(cap);
    return {
      text: `${title}. ${body} Until then Orbit understands a fixed set of commands and the buttons below.`,
      href: SETTINGS_ROUTE,
    };
  }
  return undefined;
}
