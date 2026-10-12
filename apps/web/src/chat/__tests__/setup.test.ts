import { describe, expect, it } from 'vitest';
import { isEmptyAccount, nextSetupStep, peopleWaiting, type SetupState, setupLine } from '../agent/setup';

const base: SetupState = {
  people: 0,
  linkedinImported: false,
  googleConnected: false,
  resumeOnFile: false,
  targetCompanies: 0,
  hasDraft: false,
  claude: 'none',
};
const state = (o: Partial<SetupState> = {}): SetupState => ({ ...base, ...o });
const id = (o: Partial<SetupState>) => nextSetupStep(state(o)).id;

describe('nextSetupStep', () => {
  it('starts an empty account with the LinkedIn import', () => {
    expect(id({})).toBe('linkedin');
    expect(nextSetupStep(state()).text).toContain('show_setup linkedin');
  });

  it('asks for one person by hand when the import left nobody', () => {
    expect(id({ linkedinImported: true })).toBe('add_person');
  });

  it('keeps pushing the import while the network is small, then moves to target companies', () => {
    expect(id({ people: 3 })).toBe('linkedin');
    expect(id({ people: 3, linkedinImported: true })).toBe('target_companies');
    expect(id({ people: 400 })).toBe('target_companies');
  });

  it('suggests Google only once there is a draft', () => {
    const ready = { people: 40, linkedinImported: true, targetCompanies: 2 };
    expect(id({ ...ready })).toBe('resume');
    expect(id({ ...ready, hasDraft: true })).toBe('google');
    expect(id({ ...ready, hasDraft: true, googleConnected: true })).toBe('resume');
  });

  it('is done when everything exists', () => {
    expect(
      id({
        people: 40,
        linkedinImported: true,
        targetCompanies: 2,
        hasDraft: true,
        googleConnected: true,
        resumeOnFile: true,
      }),
    ).toBe('none');
  });

  it('never suggests setup to the sample student', () => {
    expect(id({ demo: true })).toBe('none');
    expect(id({ demo: true, people: 20 })).toBe('none');
  });

  it('always gives exactly one step, in priority order', () => {
    const order: SetupState[] = [
      state(),
      state({ people: 5, linkedinImported: true }),
      state({ people: 5, linkedinImported: true, targetCompanies: 1, hasDraft: true }),
      state({ people: 5, linkedinImported: true, targetCompanies: 1, hasDraft: true, googleConnected: true }),
    ];
    expect(order.map((s) => nextSetupStep(s).id)).toEqual([
      'linkedin',
      'target_companies',
      'google',
      'resume',
    ]);
  });
});

describe('setupLine', () => {
  it('is one line with what exists and the one step', () => {
    const line = setupLine(state({ people: 12, linkedinImported: true, claude: 'shared' }));
    expect(line).toBe(
      'Setup: people 12, LinkedIn imported, Google not connected, resume none, target companies 0, Claude shared access. Suggested first step: add a few target companies (ask which ones).',
    );
    expect(line).not.toMatch(/\n|[—–!]/);
  });

  it('names a key of the student own', () => {
    expect(setupLine(state({ claude: 'own_key' }))).toContain('Claude own key');
  });
});

describe('waiting and empty', () => {
  it('counts different people with a card', () => {
    expect(peopleWaiting([{ personId: 'a' }, { personId: 'a' }, { personId: 'b' }, {}])).toBe(2);
    expect(peopleWaiting([])).toBe(0);
  });
  it('knows an empty account', () => {
    expect(isEmptyAccount({ people: 0 })).toBe(true);
    expect(isEmptyAccount({ people: 1 })).toBe(false);
  });
});
