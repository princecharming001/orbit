import { describeLlmFailure, llmEnabled, overDailyCap } from '../../integrations/anthropic';
import { llmFeatures, readPrefs } from '../../integrations/prefs';
import { sharedClaudeAvailable, sharedClaudePause, sharedClaudeUrl } from '../../integrations/shared-claude';

export const SETTINGS_ROUTE = '/settings/integrations';

/** What the no-key router can and cannot do, in the student's words. Shown as the first bubble and in the footer. */
export const ROUTER_ABILITIES =
  'It can show your day, pipeline, people, drafts and routes, move chats, add notes and start template drafts, and it still asks before anything is sent. It cannot answer free-form questions, rewrite messages in your voice or reason about what to do next.';

/**
 * 'llm' when the chat feature is on, a Claude key is saved (or Orbit's shared access is available) and today's
 * budget is not used up; 'router' otherwise. Read from the in-memory prefs: callers refresh them first when another
 * tab may have changed them.
 */
export function chatMode(): 'llm' | 'router' {
  return (llmEnabled('chat') || sharedClaudeAvailable()) && !overDailyCap() ? 'llm' : 'router';
}

/** The chat runs on Orbit's shared access rather than the student's own key. */
export function usingSharedClaude(): boolean {
  return !readPrefs().anthropicApiKey && sharedClaudeAvailable();
}

/** Why the mode is 'router', in one plain sentence with the settings route to fix it; undefined in 'llm' mode. */
export function chatModeNote(): { text: string; href?: string } | undefined {
  const p = readPrefs();
  const shared = !!sharedClaudeUrl();
  if (!p.anthropicApiKey && !shared)
    return {
      text: `Without a Claude key, Orbit understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Add your own key in Settings, Integrations to chat freely; it stays on this device.`,
      href: SETTINGS_ROUTE,
    };
  if (!llmFeatures(p).chat)
    return {
      text: `Chat with Claude is turned off, so Orbit understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Turn it on in Settings, Integrations to chat freely.`,
      href: SETTINGS_ROUTE,
    };
  const pause = !p.anthropicApiKey ? sharedClaudePause() : undefined;
  if (pause)
    return {
      text:
        pause.reason === 'unconfigured'
          ? `Orbit's shared Claude access is unavailable right now, so Orbit understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Add your own key in Settings, Integrations to chat freely; it stays on this device.`
          : pause.reason === 'budget'
            ? `You've used all the Claude that Orbit includes for you, so Orbit now understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Add your own key in Settings, Integrations to keep chatting with Claude; it stays on this device.`
            : `Orbit's shared Claude access has reached today's limit, so until tomorrow Orbit understands a fixed set of commands and the buttons below. ${ROUTER_ABILITIES} Add your own key in Settings, Integrations to keep chatting with Claude; it stays on this device.`,
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
