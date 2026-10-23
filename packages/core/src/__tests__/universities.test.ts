import { describe, expect, it } from 'vitest';
import { companyDomain, schoolDomain } from '../text/companyDomain';
import { SUB_SCHOOLS, UNIVERSITIES } from '../text/universities';

describe('the university alias table', () => {
  it('names each school once: no two rows claim the same name', () => {
    const seen = new Map<string, string>();
    const fold = (s: string) =>
      s
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    for (const [domain, ...names] of [...UNIVERSITIES, ...SUB_SCHOOLS])
      for (const n of names) {
        const k = fold(n);
        expect(seen.get(k) ?? domain, `"${n}" names both ${seen.get(k)} and ${domain}`).toBe(domain);
        seen.set(k, domain);
      }
  });

  it('every row has a plain domain and at least one name', () => {
    for (const [domain, ...names] of [...UNIVERSITIES, ...SUB_SCHOOLS]) {
      expect(domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(names.length).toBeGreaterThan(0);
    }
  });

  it('knows the UK and Ireland', () => {
    expect(schoolDomain('University of Edinburgh')).toBe('ed.ac.uk');
    expect(schoolDomain("King's College London")).toBe('kcl.ac.uk');
    expect(schoolDomain('KCL')).toBe('kcl.ac.uk');
    expect(schoolDomain('The University of Manchester')).toBe('manchester.ac.uk');
    expect(schoolDomain('Warwick')).toBe('warwick.ac.uk');
    expect(schoolDomain('London Business School')).toBe('london.edu');
    expect(schoolDomain('Trinity College Dublin')).toBe('tcd.ie');
    expect(schoolDomain('Saïd Business School, University of Oxford')).toBe('sbs.ox.ac.uk');
    expect(schoolDomain('Cambridge Judge Business School')).toBe('jbs.cam.ac.uk');
  });

  it('knows Canada', () => {
    expect(schoolDomain('University of Toronto')).toBe('utoronto.ca');
    expect(schoolDomain('U of T')).toBe('utoronto.ca');
    expect(schoolDomain("Queen's University")).toBe('queensu.ca');
    expect(schoolDomain('McMaster')).toBe('mcmaster.ca');
    expect(schoolDomain('Simon Fraser University')).toBe('sfu.ca');
    expect(schoolDomain('Rotman School of Management')).toBe('rotman.utoronto.ca');
    expect(schoolDomain('Ivey Business School, Western University')).toBe('ivey.uwo.ca');
    expect(schoolDomain('UBC Sauder')).toBe('sauder.ubc.ca');
  });

  it('knows India', () => {
    expect(schoolDomain('IIT Bombay')).toBe('iitb.ac.in');
    expect(schoolDomain('Indian Institute of Technology, Delhi')).toBe('iitd.ac.in');
    expect(schoolDomain('IIT Madras')).toBe('iitm.ac.in');
    expect(schoolDomain('BITS Pilani')).toBe('bits-pilani.ac.in');
    expect(schoolDomain('Birla Institute of Technology & Science')).toBe('bits-pilani.ac.in');
    expect(schoolDomain('IIM Ahmedabad')).toBe('iima.ac.in');
    expect(schoolDomain('Indian Institute of Management Bangalore')).toBe('iimb.ac.in');
    expect(schoolDomain('Indian School of Business')).toBe('isb.edu');
    expect(schoolDomain('Delhi University')).toBe('du.ac.in');
    expect(schoolDomain('NIT Trichy')).toBe('nitt.edu');
    expect(schoolDomain('Vellore Institute of Technology')).toBe('vit.ac.in');
  });

  it('gives the business schools the founder named their own domain', () => {
    expect(companyDomain('NYU Stern')).toBe('stern.nyu.edu');
    expect(companyDomain('New York University - Leonard N. Stern School of Business')).toBe('stern.nyu.edu');
    expect(companyDomain('Stern School of Business, New York University')).toBe('stern.nyu.edu');
    expect(companyDomain('UC Berkeley')).toBe('berkeley.edu');
    expect(companyDomain('Haas')).toBe('haas.berkeley.edu');
    expect(companyDomain('University of California, Berkeley - Walter A. Haas School of Business')).toBe(
      'haas.berkeley.edu',
    );
    expect(companyDomain('Berkeley Haas')).toBe('haas.berkeley.edu');
    expect(companyDomain('Kellogg School of Management')).toBe('kellogg.northwestern.edu');
    expect(companyDomain('Columbia Business School')).toBe('business.columbia.edu');
  });

  it('does not mistake a city, a company or a cereal for a school', () => {
    expect(companyDomain('City of Toronto')).toBeUndefined();
    expect(companyDomain('Kellogg')).not.toBe('kellogg.northwestern.edu');
    expect(companyDomain('Darden Restaurants')).toBeUndefined();
    expect(companyDomain('Bath & Body Works')).toBeUndefined();
    expect(companyDomain('Oxford University Press')).not.toBe('ox.ac.uk');
  });
});
