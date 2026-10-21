import { describe, expect, it } from 'vitest';
import { companyDomain } from '../text/companyDomain';

describe('a company logo domain', () => {
  it('knows the companies students aim for, however the name is written', () => {
    expect(companyDomain('McKinsey & Company')).toBe('mckinsey.com');
    expect(companyDomain('Goldman Sachs & Co. LLC')).toBe('goldmansachs.com');
    expect(companyDomain('Linear')).toBe('linear.app');
    expect(companyDomain('Notion')).toBe('notion.so');
    expect(companyDomain('Georgia Tech')).toBe('gatech.edu');
    expect(companyDomain('Carnegie Mellon University')).toBe('cmu.edu');
  });

  it('prefers a stored domain, then a work address, never a free mailbox or a school', () => {
    expect(companyDomain('Acme Robotics', { domains: ['https://www.acme.ai/about'] })).toBe('acme.ai');
    expect(
      companyDomain('Acme Robotics', { emails: ['jo@gmail.com', 'jo@cornell.edu', 'jo@acmerobotics.io'] }),
    ).toBe('acmerobotics.io');
    expect(companyDomain('Acme Robotics', { emails: ['jo@gmail.com'] })).toBeUndefined();
  });

  it('guesses .com only for a one-word name', () => {
    expect(companyDomain('Ramp')).toBe('ramp.com');
    expect(companyDomain('Figma, Inc.')).toBe('figma.com');
    expect(companyDomain('Blue Harbor Partners')).toBeUndefined();
    expect(companyDomain('')).toBeUndefined();
  });
});
