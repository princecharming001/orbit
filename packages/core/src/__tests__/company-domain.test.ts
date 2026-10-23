import { describe, expect, it } from 'vitest';
import { companyDomain, companyInitials, judgeLogo, logoSources } from '../text/companyDomain';

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

describe('a school logo domain', () => {
  it('maps universities however students write them', () => {
    expect(companyDomain('UC Berkeley')).toBe('berkeley.edu');
    expect(companyDomain('University of California, Berkeley')).toBe('berkeley.edu');
    expect(companyDomain('University of California at Berkeley')).toBe('berkeley.edu');
    expect(companyDomain('Georgia Tech')).toBe('gatech.edu');
    expect(companyDomain('Georgia Institute of Technology')).toBe('gatech.edu');
    expect(companyDomain('UIUC')).toBe('illinois.edu');
    expect(companyDomain('University of Illinois Urbana-Champaign')).toBe('illinois.edu');
    expect(companyDomain('UT Austin')).toBe('utexas.edu');
    expect(companyDomain('The University of Texas at Austin')).toBe('utexas.edu');
    expect(companyDomain('University of Michigan')).toBe('umich.edu');
    expect(companyDomain('University of Michigan - Ann Arbor')).toBe('umich.edu');
    expect(companyDomain('New York University')).toBe('nyu.edu');
    expect(companyDomain('Texas A&M University')).toBe('tamu.edu');
  });

  it('gives a school inside a university its own domain', () => {
    expect(companyDomain('NYU Stern')).toBe('stern.nyu.edu');
    expect(companyDomain('NYU Stern School of Business')).toBe('stern.nyu.edu');
    expect(companyDomain('Stanford GSB')).toBe('gsb.stanford.edu');
    expect(companyDomain('Stanford Graduate School of Business')).toBe('gsb.stanford.edu');
    expect(companyDomain('Harvard Business School')).toBe('hbs.edu');
    expect(companyDomain('MIT Sloan School of Management')).toBe('mitsloan.mit.edu');
    expect(companyDomain('MIT Sloan')).toBe('mitsloan.mit.edu');
    expect(companyDomain('The Wharton School')).toBe('wharton.upenn.edu');
    expect(companyDomain('UC Berkeley, Haas School of Business')).toBe('haas.berkeley.edu');
    expect(companyDomain('University of Michigan - Stephen M. Ross School of Business')).toBe(
      'michiganross.umich.edu',
    );
  });

  it('reads "<school> at <university>" and "<university> <school>" as the university', () => {
    expect(companyDomain('School of Engineering at Tufts University')).toBe('tufts.edu');
    expect(companyDomain('Stanford School of Medicine')).toBe('stanford.edu');
    expect(companyDomain('Boston University Questrom')).toBe('bu.edu');
    expect(companyDomain('School of Engineering and Applied Science of the University of Virginia')).toBe(
      'virginia.edu',
    );
    expect(companyDomain('Georgia Tech Research Institute')).toBe('gatech.edu');
  });

  it('never takes a company that shares a short school name for the school', () => {
    expect(companyDomain('Columbia Sportswear')).toBeUndefined();
    expect(companyDomain('Duke Energy')).toBeUndefined();
    expect(companyDomain('Northwestern Mutual')).toBeUndefined();
    expect(companyDomain('Princeton Review')).toBeUndefined();
  });

  it('still knows the companies', () => {
    expect(companyDomain('Meta')).toBe('meta.com');
    expect(companyDomain('Facebook')).toBe('meta.com');
    expect(companyDomain('Google')).toBe('google.com');
    expect(companyDomain('Jane Street')).toBe('janestreet.com');
    expect(companyDomain('Two Sigma')).toBe('twosigma.com');
  });
});

describe('a logo image', () => {
  it('is looked for at DuckDuckGo, then Google, then the site itself', () => {
    expect(logoSources('berkeley.edu').map((s) => s.kind)).toEqual([
      'duckduckgo',
      'google',
      'touch',
      'favicon',
    ]);
    expect(logoSources('https://www.stripe.com/')[1]!.url).toBe(
      'https://www.google.com/s2/favicons?domain=stripe.com&sz=128',
    );
  });

  it("treats DuckDuckGo's 48 px stand-in and Google's 16 px globe as missing", () => {
    expect(judgeLogo('duckduckgo', 48, 48)).toBe('missing');
    expect(judgeLogo('duckduckgo', 32, 32)).toBe('ok');
    expect(judgeLogo('duckduckgo', 16, 16)).toBe('weak');
    expect(judgeLogo('google', 16, 16)).toBe('missing');
    expect(judgeLogo('google', 128, 128)).toBe('ok');
    expect(judgeLogo('touch', 180, 180)).toBe('ok');
    expect(judgeLogo('touch', 0, 0)).toBe('missing');
    expect(judgeLogo('favicon', 16, 16)).toBe('ok');
  });

  it('falls back to initials', () => {
    expect(companyInitials('Blue Harbor Partners')).toBe('BH');
    expect(companyInitials('NYU Stern')).toBe('NS');
    expect(companyInitials('University of Chicago')).toBe('UC');
    expect(companyInitials('Datadog')).toBe('D');
    expect(companyInitials('The Walt Disney Company', 1)).toBe('W');
  });
});
