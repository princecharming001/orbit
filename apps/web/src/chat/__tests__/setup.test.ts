import { describe, expect, it } from 'vitest';
import { isEmptyAccount, nextSetupStep, peopleWaiting, type SetupState, setupLine } from '../agent/setup';

const base: SetupState = {
  people: 0,
  linkedinImported: false,
  googleConnected: false,
  resumeOnFile: false,
  targetCompanies: 0,
  claude: 'none',
};
const state = (o: Partial<SetupState> = {}): SetupState => ({ ...base, ...o });
const id = (o: Partial<SetupState>) => nextSetupStep(state(o)).id;

describe('nextSetupStep', () => {
  it('starts an empty account with LinkedIn: the export, or connecting live where Orbit offers it', () => {
    expect(id({})).toBe('linkedin');
    expect(nextSetupStep(state()).text).toBe('import LinkedIn connections (show_setup linkedin)');
    expect(nextSetupStep(state({ liveLinkedInAvailable: true })).text).toBe(
      'connect LinkedIn so their connections stay in sync (show_setup linkedin)',
    );
  });

  it('keeps asking for LinkedIn until it is in, however many people there are', () => {
    expect(id({ people: 3 })).toBe('linkedin');
    expect(id({ people: 400, googleConnected: true, targetCompanies: 2 })).toBe('linkedin');
    // connected live counts as in
    expect(id({ people: 40, linkedinImported: true, linkedinLive: true })).toBe('google');
  });

  it('asks for Gmail next whenever it is not connected, with or without a draft', () => {
    expect(id({ people: 40, linkedinImported: true })).toBe('google');
    expect(id({ people: 40, linkedinImported: true, targetCompanies: 2 })).toBe('google');
    expect(nextSetupStep(state({ people: 40, linkedinImported: true })).text).toBe(
      'connect Gmail so Orbit sees who they email and drafts can go out (show_setup google)',
    );
  });

  it('never suggests Gmail where Google sign-in is not set up, and says so in the Setup line', () => {
    expect(id({ people: 40, linkedinImported: true, googleAvailable: false })).toBe('target_companies');
    expect(setupLine(state({ people: 40, linkedinImported: true, googleAvailable: false }))).toMatch(
      /Gmail not available in this copy of Orbit yet/,
    );
  });

  it('asks for one person by hand when LinkedIn and Gmail left nobody', () => {
    expect(id({ linkedinImported: true, googleConnected: true })).toBe('add_person');
  });

  it('then target companies, then the resume', () => {
    const ready = { people: 40, linkedinImported: true, googleConnected: true };
    expect(id(ready)).toBe('target_companies');
    expect(id({ ...ready, targetCompanies: 2 })).toBe('resume');
  });

  it('is done when everything exists', () => {
    expect(
      id({
        people: 40,
        linkedinImported: true,
        targetCompanies: 2,
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
      state({ people: 0, linkedinImported: true, googleConnected: true }),
      state({ people: 5, linkedinImported: true, googleConnected: true }),
      state({ people: 5, linkedinImported: true, googleConnected: true, targetCompanies: 1 }),
      state({
        people: 5,
        linkedinImported: true,
        googleConnected: true,
        targetCompanies: 1,
        resumeOnFile: true,
      }),
    ];
    expect(order.map((s) => nextSetupStep(s).id)).toEqual([
      'linkedin',
      'google',
      'add_person',
      'target_companies',
      'resume',
      'none',
    ]);
  });
});

describe('setupLine', () => {
  it('is one line with what exists and the one step', () => {
    const line = setupLine(state({ people: 12, linkedinImported: true, claude: 'shared' }));
    expect(line).toBe(
      'Setup: people 12, LinkedIn imported, Gmail not connected, resume none, target companies 0, Claude shared access. Suggested first step: connect Gmail so Orbit sees who they email and drafts can go out (show_setup google).',
    );
    expect(line).not.toMatch(/\n|[—–!]/);
  });

  it('says when LinkedIn is missing or connected live', () => {
    expect(setupLine(state())).toMatch(/^Setup: people 0, LinkedIn not connected, Gmail not connected,/);
    expect(setupLine(state({ linkedinImported: true, linkedinLive: true }))).toMatch(
      /LinkedIn connected live/,
    );
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
