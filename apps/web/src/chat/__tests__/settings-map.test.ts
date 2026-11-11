import { describe, expect, it } from 'vitest';
import { type RouterContext, routeUtterance } from '../agent/router';
import { registry } from '../registry';
import { findSetting, SETTINGS, settingAsked, settingById, settingHref } from '../settingsMap';

describe('the map of settings', () => {
  it('every setting has its own id, a section, a line on what is there, and an address', () => {
    expect(new Set(SETTINGS.map((s) => s.id)).size).toBe(SETTINGS.length);
    for (const s of SETTINGS) {
      expect(s.id, s.id).toMatch(/^[a-z][a-z-]*$/);
      expect(s.what.length, s.id).toBeGreaterThan(12);
      expect(s.what, s.id).not.toMatch(/[—–!]/);
      expect(settingHref(s)).toBe(`/settings/${s.section}#${s.id}`);
      expect(settingById(s.id)).toBe(s);
    }
    expect(settingById('nope')).toBeUndefined();
  });

  it('names the setting a student means, however they say it', () => {
    const cases: [string, string][] = [
      ['where do I add my resume', 'resume'],
      ['update my CV', 'resume'],
      ['I want to replace my résumé', 'resume'],
      ['change my tone', 'tone'],
      ['how do I change my writing style', 'tone'],
      ['can I make my sign-off different', 'tone'],
      ['connect Calendly', 'calendly'],
      ['how do I connect cal.com', 'calcom'],
      ['change my booking link', 'booking-link'],
      ['connect Granola', 'granola'],
      ['add my notetaker', 'notetaker'],
      ['connect my LinkedIn', 'linkedin'],
      ['update my linkedin url', 'profile-linkedin'],
      ['connect gmail', 'google'],
      ['turn on autopilot', 'autopilot'],
      ['change my weekly target', 'weekly-target'],
      ['change how many follow-ups you send', 'follow-ups'],
      ['change my sending days', 'send-days'],
      ['change my daily limit', 'sending-limits'],
      ['turn off the morning brief', 'morning-brief'],
      ['edit my target companies', 'target-companies'],
      ['change my target roles', 'target-roles'],
      ['update my target industries', 'target-industries'],
      ['change my major', 'majors'],
      ['fix my graduation year', 'grad-year'],
      ['change my time zone', 'timezone'],
      ['update my phone number', 'phone'],
      ['how do I change the number you text me at', 'phone'],
      ['where is memory', 'memory'],
      ['how do I delete my data', 'delete-data'],
      ['where are the privacy settings', 'privacy'],
    ];
    for (const [said, id] of cases) expect(settingAsked(said)?.id, said).toBe(id);
  });

  it('using a setting is not asking to change it', () => {
    for (const said of [
      'draft a note to Lena with my resume in mind',
      'who do I know at Google',
      'find people in my industry',
      'what is my weekly target',
      'did my tone work on Maya',
      'thanks',
    ])
      expect(settingAsked(said), said).toBeUndefined();
    // the words alone still find the setting, for the model's own use
    expect(findSetting('my resume')?.id).toBe('resume');
  });
});

describe('the fallback router sends a setting ask to its card', () => {
  const ctx: RouterContext = {
    registry,
    people: [],
    companies: ['Stripe', 'Ramp'],
    goals: [],
    paths: [],
    account: false,
    modeNote: '',
    settingsHref: '/settings/integrations',
  };
  const setting = (said: string) => {
    const r = routeUtterance(said, ctx);
    return r.kind === 'tool' && r.tool === 'open_page'
      ? (r.input as { setting?: string }).setting
      : undefined;
  };
  it('for settings nothing in the chat changes by itself', () => {
    const all: [string, string | undefined][] = [
      ['where do I add my resume', 'resume'],
      ['connect Calendly', 'calendly'],
      ['how do I connect cal.com', 'calcom'],
      ['how do I change my booking link', 'booking-link'],
      ['change my time zone', 'timezone'],
      ['change my tone', 'tone'],
      ['connect Granola', 'granola'],
      ['how do I change my sending days', 'send-days'],
      ['edit my target companies', 'target-companies'],
      ['how do I delete my data', 'delete-data'],
    ];
    const got = all.map(([said]) => [said, setting(said)]);
    expect(got).toEqual(all);
  });
});
