import type { ChipSpec } from '../types';

/**
 * The home's "Connect your apps" strip: each Connect button posts the matching setup widget into the thread, through
 * the same direct run as a chip (no model call). They are not shown with the chips.
 */
export const SETUP_CHIPS: ChipSpec[] = [
  {
    id: 'connect-linkedin',
    label: 'Connect LinkedIn',
    tool: 'show_setup',
    input: { what: 'linkedin' },
    asUser: 'Connect my LinkedIn.',
  },
  {
    id: 'connect-gmail',
    label: 'Connect Gmail',
    tool: 'show_setup',
    input: { what: 'google' },
    asUser: 'Connect my Gmail.',
  },
];
