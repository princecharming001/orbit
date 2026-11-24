/** Placeholder: the source side implements this (plan 44 §4). */
import type { RoleSources } from './contracts.ts';
export const roleSources: RoleSources = {
  keep: () => Promise.reject(new Error('roles sources not built')),
  text: () => Promise.resolve(undefined),
  linkedinSearch: () => Promise.resolve([]),
  readUrl: () => Promise.resolve({ problem: 'not built' }),
};
