"""
Builds apps/web/src/data/schools.json, the list the School field suggests from.

US: every active degree-granting college in IPEDS (NCES HD file: https://nces.ed.gov/ipeds/datacenter/data/HD2023.zip),
with its other names (IALIAS). Elsewhere: the open university-domains list
(https://github.com/Hipo/university-domains-list, world_universities_and_domains.json), whose names also replace
IPEDS's "University of X-Campus" form when the two share a web domain.

  python3 -I scripts/schools/build.py <HD2023.csv> <world_universities_and_domains.json>

Each row is [name, domain, where, aliases, kind]: kind 1 = US four-year, 2 = US two-year, 3 = outside the US.
"""
import csv
import json
import re
import sys

hd_path, hipo_path = sys.argv[1], sys.argv[2]
out_path = 'apps/web/src/data/schools.json'


def domain_of(url: str) -> str:
    d = re.sub(r'^https?://', '', (url or '').strip().lower()).split('/')[0]
    return re.sub(r'^www\d*\.', '', d)


hipo = json.load(open(hipo_path, encoding='utf-8'))
hipo_by_domain = {}
for h in hipo:
    for d in h.get('domains') or []:
        hipo_by_domain.setdefault(d.lower(), h['name'])


def clean_us(name: str, domain: str) -> str:
    name = re.sub(r'-Main Campus$', '', name).strip()
    better = hipo_by_domain.get(domain)
    # the open list writes campuses the way students do ("University of California, Berkeley"); take it when it is
    # the same school, not a system or a district
    if better and not re.search(r'district|system', better, re.I) and better.split(',')[0].split(' ')[0] == name.split('-')[0].split(',')[0].split(' ')[0]:
        return better
    # "University of Michigan-Ann Arbor" → "University of Michigan, Ann Arbor"
    m = re.match(r'^(.*\b(?:University|College|Institute)\b[^-]*)-([A-Z].*)$', name)
    if m and ' ' not in m.group(1).split('-')[-1][:1]:
        return f'{m.group(1)}, {m.group(2)}'
    return name


rows = []
seen = set()
with open(hd_path, encoding='latin-1') as f:
    for r in csv.DictReader(f):
        if r['DEGGRANT'] != '1' or r['CYACTIVE'] not in ('1', '3'):
            continue
        domain = domain_of(r['WEBADDR'])
        name = clean_us(r['INSTNM'], domain)
        aliases = [a.strip() for a in re.split(r'[|;,]', r['IALIAS'] or '') if 1 < len(a.strip()) <= 40]
        if r['INSTNM'] != name:
            aliases.append(re.sub(r'-Main Campus$', '', r['INSTNM']))
        kind = 1 if r['ICLEVEL'] == '1' else 2
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        rows.append([name, domain, f"{r['CITY']}, {r['STABBR']}", '|'.join(dict.fromkeys(aliases)), kind])

for h in hipo:
    if h.get('alpha_two_code') == 'US':
        continue
    key = h['name'].lower()
    if key in seen:
        continue
    seen.add(key)
    rows.append([h['name'], (h.get('domains') or [''])[0].lower(), h.get('country') or '', '', 3])

# what students call them: the first school whose name matches the pattern gets these
SHORT = {
    r'^University of Michigan - Ann Arbor$': 'UMich|Michigan|U of M',
    r'^University of Pennsylvania$': 'Penn|UPenn',
    r'^University of California, Berkeley$': 'Cal|UC Berkeley|UCB|Berkeley',
    r'^University of California, Los Angeles$': 'UCLA',
    r'^University of California, San Diego$': 'UCSD',
    r'^University of California, Davis$': 'UC Davis|UCD',
    r'^University of California, Irvine$': 'UC Irvine|UCI',
    r'^University of California, Santa Barbara$': 'UCSB',
    r'^University of California, Santa Cruz$': 'UCSC',
    r'^University of California, Riverside$': 'UCR',
    r'^Georgia Institute of Technology$': 'Georgia Tech|GT|GaTech',
    r'^California Institute of Technology$': 'Caltech',
    r'^Washington University, Saint Louis$': 'WashU|WUSTL|Washington University in St. Louis',
    r'^Johns Hopkins University$': 'Hopkins|JHU',
    r'^University of Illinois Urbana-Champaign$': 'UIUC|Illinois',
    r'^University of Washington$': 'UW|UDub',
    r'^The University of Texas at Austin$': 'UT Austin|UT',
    r'^Carnegie Mellon University$': 'CMU',
    r'^Massachusetts Institute of Technology$': 'MIT',
    r'^University of Southern California$': 'USC',
    r'^New York University$': 'NYU',
    r'^University of North Carolina at Chapel Hill$': 'UNC|Chapel Hill',
    r'^University of Virginia, Charlottesville$': 'UVA',
    r'^Pennsylvania State University$': 'Penn State|PSU',
    r'^Ohio State University - Columbus$': 'OSU|Ohio State|The Ohio State University',
    r'^Arizona State University$': 'ASU',
    r'^California Polytechnic State University, San Luis Obispo$': 'Cal Poly|Cal Poly SLO',
    r'^Virginia Tech$': 'VT|Virginia Polytechnic Institute',
    r'^Texas A ?& ?M University( - College Station)?$': 'TAMU|Texas A&M|A&M',
    r'^University of Colorado (at )?Boulder$': 'CU Boulder',
    r'^University of Wisconsin - Madison$|^University of Wisconsin-Madison$': 'UW Madison|Wisconsin',
    r'^University of Minnesota, Twin Cities$': 'UMN|Minnesota',
    r'^University of Maryland, College Park$': 'UMD|Maryland',
    r'^Boston University$': 'BU',
    r'^Boston College$': 'BC',
    r'^San Jose State University$': 'SJSU',
    r'^San Diego State University$': 'SDSU',
    r'^Rensselaer Polytechnic Institute$': 'RPI',
    r'^Worcester Polytechnic Institute$': 'WPI',
    r'^Case Western Reserve University$': 'CWRU|Case Western',
    r'^University of Chicago$': 'UChicago',
    r'^Rutgers University, New Brunswick$': 'Rutgers',
    r'^University of Florida$': 'UF',
    r'^University of Notre Dame$': 'Notre Dame|ND',
}
for pattern, short in SHORT.items():
    for row in rows:
        if re.search(pattern, row[0]):
            row[3] = '|'.join(dict.fromkeys([*short.split('|'), *[a for a in row[3].split('|') if a]]))
            break
    else:
        print('no school for', pattern)

json.dump(rows, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(rows), 'schools')
