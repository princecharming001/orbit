import json, math, sys, unicodedata, re
G = sys.argv[1]; OUT = sys.argv[2]
def fold(s):
    s = unicodedata.normalize('NFKD', s); s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', ' ', s.lower())).strip()
# id, label, aliases, lat, lon, radius km, country
METROS = [
 ('sf_bay','San Francisco Bay Area',['bay area','sf bay area','sf','san francisco','silicon valley','sfba','the bay','norcal bay area','sf bay'],37.62,-122.2,75,'US'),
 ('nyc','New York City Metropolitan Area',['nyc','new york','new york city','ny','manhattan','brooklyn','greater new york','tri state area','new york metro'],40.73,-73.99,60,'US'),
 ('la','Los Angeles Metropolitan Area',['la','los angeles','greater los angeles','socal','so cal'],34.05,-118.24,70,'US'),
 ('seattle','Greater Seattle Area',['seattle','greater seattle','puget sound'],47.61,-122.33,50,'US'),
 ('boston','Greater Boston',['boston','greater boston','boston area','cambridge ma'],42.36,-71.06,45,'US'),
 ('chicago','Greater Chicago Area',['chicago','chicagoland','greater chicago'],41.88,-87.63,55,'US'),
 ('austin','Austin, Texas Metropolitan Area',['austin','atx','greater austin'],30.27,-97.74,45,'US'),
 ('dallas','Dallas-Fort Worth Metroplex',['dallas','dfw','fort worth','dallas fort worth'],32.85,-97.0,65,'US'),
 ('houston','Greater Houston',['houston','greater houston'],29.76,-95.37,60,'US'),
 ('dc','Washington DC-Baltimore Area',['dc','washington dc','washington d c','dmv','dc metro','washington dc baltimore area','baltimore','northern virginia','nova'],38.95,-76.95,70,'US'),
 ('atlanta','Atlanta Metropolitan Area',['atlanta','atl','greater atlanta'],33.75,-84.39,55,'US'),
 ('miami','Miami-Fort Lauderdale Area',['miami','south florida','fort lauderdale','miami fort lauderdale area'],26.0,-80.2,60,'US'),
 ('denver','Denver Metropolitan Area',['denver','boulder','front range'],39.84,-105.0,50,'US'),
 ('san_diego','San Diego Metropolitan Area',['san diego','sd'],32.85,-117.1,45,'US'),
 ('philadelphia','Greater Philadelphia',['philadelphia','philly'],39.95,-75.17,45,'US'),
 ('phoenix','Greater Phoenix Area',['phoenix','greater phoenix','scottsdale','tempe'],33.45,-112.0,55,'US'),
 ('minneapolis','Greater Minneapolis-St. Paul Area',['minneapolis','twin cities','st paul','msp'],44.96,-93.2,45,'US'),
 ('detroit','Greater Detroit',['detroit','ann arbor','metro detroit'],42.4,-83.3,55,'US'),
 ('pittsburgh','Greater Pittsburgh Region',['pittsburgh'],40.44,-80.0,35,'US'),
 ('portland','Portland, Oregon Metropolitan Area',['portland','pdx'],45.52,-122.68,40,'US'),
 ('sacramento','Sacramento Metropolitan Area',['sacramento','davis'],38.58,-121.49,40,'US'),
 ('raleigh','Raleigh-Durham-Chapel Hill Area',['raleigh','durham','research triangle','the triangle','chapel hill','rdu'],35.85,-78.8,40,'US'),
 ('nashville','Nashville Metropolitan Area',['nashville'],36.16,-86.78,40,'US'),
 ('salt_lake','Salt Lake City Metropolitan Area',['salt lake city','slc','provo','utah county','silicon slopes'],40.6,-111.9,60,'US'),
 ('columbus','Columbus, Ohio Metropolitan Area',['columbus'],39.96,-83.0,35,'US'),
 ('charlotte','Charlotte Metro',['charlotte'],35.23,-80.84,40,'US'),
 ('las_vegas','Las Vegas Metropolitan Area',['las vegas','vegas'],36.17,-115.14,35,'US'),
 ('san_antonio','San Antonio, Texas Metropolitan Area',['san antonio'],29.42,-98.49,40,'US'),
 ('orlando','Orlando, Florida Area',['orlando'],28.54,-81.38,40,'US'),
 ('tampa','Tampa Bay Area',['tampa','tampa bay','st petersburg'],27.95,-82.46,40,'US'),
 ('st_louis','Greater St. Louis',['st louis','saint louis'],38.63,-90.2,40,'US'),
 ('kansas_city','Kansas City Metropolitan Area',['kansas city','kc'],39.1,-94.58,40,'US'),
 ('indianapolis','Indianapolis Metropolitan Area',['indianapolis','indy'],39.77,-86.16,35,'US'),
 ('cincinnati','Cincinnati Metropolitan Area',['cincinnati'],39.1,-84.51,35,'US'),
 ('cleveland','Cleveland-Akron Area',['cleveland','akron'],41.3,-81.6,45,'US'),
 ('madison','Madison, Wisconsin Metropolitan Area',['madison'],43.07,-89.4,30,'US'),
 ('new_haven','New Haven Metropolitan Area',['new haven'],41.31,-72.92,25,'US'),
 ('princeton','Princeton, New Jersey',['princeton'],40.35,-74.66,15,'US'),
 ('ithaca','Ithaca, New York',['ithaca'],42.44,-76.5,20,'US'),
 ('santa_barbara','Santa Barbara',['santa barbara','isla vista','goleta'],34.42,-119.75,25,'US'),
 ('santa_cruz','Santa Cruz',['santa cruz'],36.97,-122.03,15,'US'),
 ('irvine','Orange County',['irvine','orange county','oc'],33.7,-117.83,30,'US'),
 ('honolulu','Honolulu',['honolulu','oahu'],21.31,-157.86,40,'US'),
 ('toronto','Greater Toronto Area',['toronto','gta','greater toronto'],43.7,-79.4,55,'CA'),
 ('waterloo','Kitchener-Waterloo',['waterloo','kitchener','kitchener waterloo','kw'],43.46,-80.52,20,'CA'),
 ('vancouver','Greater Vancouver',['vancouver','metro vancouver'],49.25,-123.1,40,'CA'),
 ('montreal','Greater Montreal',['montreal'],45.5,-73.57,40,'CA'),
 ('london','Greater London',['london','greater london','london area'],51.51,-0.12,45,'GB'),
 ('cambridge_uk','Cambridge, UK',['cambridge uk'],52.2,0.12,15,'GB'),
 ('oxford_uk','Oxford, UK',['oxford'],51.75,-1.26,15,'GB'),
 ('manchester','Greater Manchester',['manchester'],53.48,-2.24,30,'GB'),
 ('edinburgh','Edinburgh',['edinburgh'],55.95,-3.19,20,'GB'),
 ('dublin','Dublin',['dublin'],53.35,-6.26,25,'IE'),
 ('paris','Paris Region',['paris','ile de france','greater paris'],48.86,2.35,40,'FR'),
 ('berlin','Berlin Metropolitan Area',['berlin'],52.52,13.4,35,'DE'),
 ('munich','Munich',['munich','munchen'],48.14,11.58,30,'DE'),
 ('amsterdam','Amsterdam Area',['amsterdam','randstad'],52.37,4.9,35,'NL'),
 ('zurich','Zurich',['zurich'],47.37,8.54,30,'CH'),
 ('stockholm','Stockholm',['stockholm'],59.33,18.07,35,'SE'),
 ('madrid','Madrid',['madrid'],40.42,-3.7,35,'ES'),
 ('barcelona','Barcelona',['barcelona'],41.39,2.17,30,'ES'),
 ('lisbon','Lisbon',['lisbon','lisboa'],38.72,-9.14,30,'PT'),
 ('tel_aviv','Tel Aviv Area',['tel aviv','tel aviv yafo','gush dan'],32.08,34.78,30,'IL'),
 ('dubai','Dubai',['dubai','uae dubai'],25.2,55.27,40,'AE'),
 ('bangalore','Bengaluru',['bangalore','bengaluru','blr'],12.97,77.59,40,'IN'),
 ('delhi','Delhi NCR',['delhi','new delhi','ncr','delhi ncr','gurgaon','gurugram','noida'],28.6,77.2,50,'IN'),
 ('mumbai','Mumbai Metropolitan Region',['mumbai','bombay','navi mumbai','thane'],19.08,72.88,45,'IN'),
 ('hyderabad','Hyderabad',['hyderabad'],17.39,78.49,40,'IN'),
 ('pune','Pune',['pune'],18.52,73.86,35,'IN'),
 ('chennai','Chennai',['chennai','madras'],13.08,80.27,40,'IN'),
 ('kolkata','Kolkata',['kolkata','calcutta'],22.57,88.36,40,'IN'),
 ('singapore','Singapore',['singapore','sg'],1.35,103.82,30,'SG'),
 ('hong_kong','Hong Kong',['hong kong','hk'],22.32,114.17,30,'HK'),
 ('shanghai','Shanghai',['shanghai'],31.23,121.47,50,'CN'),
 ('beijing','Beijing',['beijing'],39.9,116.4,50,'CN'),
 ('shenzhen','Shenzhen',['shenzhen'],22.54,114.06,35,'CN'),
 ('tokyo','Greater Tokyo Area',['tokyo'],35.68,139.69,50,'JP'),
 ('seoul','Seoul Capital Area',['seoul'],37.57,126.98,45,'KR'),
 ('taipei','Taipei',['taipei'],25.03,121.57,30,'TW'),
 ('sydney','Greater Sydney',['sydney'],-33.87,151.21,50,'AU'),
 ('melbourne','Greater Melbourne',['melbourne'],-37.81,144.96,50,'AU'),
 ('sao_paulo','Sao Paulo',['sao paulo'],-23.55,-46.63,50,'BR'),
 ('mexico_city','Mexico City',['mexico city','cdmx','ciudad de mexico'],19.43,-99.13,45,'MX'),
 ('lagos','Lagos',['lagos'],6.52,3.38,40,'NG'),
 ('nairobi','Nairobi',['nairobi'],-1.29,36.82,30,'KE'),
 ('karachi','Karachi',['karachi'],24.86,67.0,40,'PK'),
 ('lahore','Lahore',['lahore'],31.55,74.34,35,'PK'),
 ('istanbul','Istanbul',['istanbul'],41.01,28.98,50,'TR'),
 ('cairo','Cairo',['cairo'],30.04,31.24,40,'EG'),
 ('jakarta','Jakarta',['jakarta'],-6.2,106.85,45,'ID'),
]
def hav(a,b,c,d):
    R=6371; p=math.pi/180
    x=math.sin((c-a)*p/2)**2+math.cos(a*p)*math.cos(c*p)*math.sin((d-b)*p/2)**2
    return 2*R*math.asin(math.sqrt(x))
admin1={}
for l in open(f'{G}/admin1CodesASCII.txt',encoding='utf8'):
    k,name,ascii_,_=l.rstrip('\n').split('\t'); admin1[k]=ascii_
countries={}
for l in open(f'{G}/countryInfo.txt',encoding='utf8'):
    if l.startswith('#'): continue
    f=l.rstrip('\n').split('\t'); countries[f[0]]=f[4]
cities=[]
for l in open(f'{G}/cities15000.txt',encoding='utf8'):
    f=l.rstrip('\n').split('\t')
    cities.append(dict(name=f[2] or f[1], lat=float(f[4]), lon=float(f[5]), cc=f[8], a1=f[10], pop=int(f[14] or 0)))
# city rows: [folded name, region (folded admin1 name), cc, metroId or '', pop rank bucket]
out_cities=[]
for c in cities:
    best=None
    for m in METROS:
        if m[6]!=c['cc']: continue
        d=hav(c['lat'],c['lon'],m[3],m[4])
        if d<=m[5] and (best is None or d<best[0]): best=(d,m[0])
    region=admin1.get(f"{c['cc']}.{c['a1']}",'')
    out_cities.append((fold(c['name']), fold(region), c['cc'], best[1] if best else '', c['pop']))
# keep: every city in a metro, plus cities >= 100k anywhere (country resolution for "City, Country")
keep=[r for r in out_cities if r[3] or r[4]>=250000]
keep.sort(key=lambda r:-r[4])
regions={}
for k,v in admin1.items():
    cc=k.split('.')[0]
    if cc in ('US','CA','IN','AU','GB','CN','DE','BR','MX'): regions.setdefault(cc,[]).append(fold(v))
US_ABBR={'AL':'alabama','AK':'alaska','AZ':'arizona','AR':'arkansas','CA':'california','CO':'colorado','CT':'connecticut','DE':'delaware','FL':'florida','GA':'georgia','HI':'hawaii','ID':'idaho','IL':'illinois','IN':'indiana','IA':'iowa','KS':'kansas','KY':'kentucky','LA':'louisiana','ME':'maine','MD':'maryland','MA':'massachusetts','MI':'michigan','MN':'minnesota','MS':'mississippi','MO':'missouri','MT':'montana','NE':'nebraska','NV':'nevada','NH':'new hampshire','NJ':'new jersey','NM':'new mexico','NY':'new york','NC':'north carolina','ND':'north dakota','OH':'ohio','OK':'oklahoma','OR':'oregon','PA':'pennsylvania','RI':'rhode island','SC':'south carolina','SD':'south dakota','TN':'tennessee','TX':'texas','UT':'utah','VT':'vermont','VA':'virginia','WA':'washington','WV':'west virginia','WI':'wisconsin','WY':'wyoming','DC':'washington d c'}
data={
 'metros':[[m[0],m[1],[fold(a) for a in m[2]],m[6]] for m in METROS],
 'cities':['|'.join([r[0],r[1],r[2],r[3]]) for r in keep],
 'countries':{cc:fold(n) for cc,n in countries.items()},
 'regions':regions,
 'usAbbr':US_ABBR,
}
HEADER = """/**
 * Places data for network search (plan 32 §5.3), generated by scripts/search/places_gen.py from GeoNames
 * cities15000 and admin1 codes (CC BY 4.0, https://www.geonames.org) plus a curated table of metros. Each city row is
 * "name|region|country|metro", sorted by population; cities outside a metro are kept when they have 250k people or more.
 * Do not edit by hand.
 */
import type { PlacesData } from './places';

export const PLACES_DATA: PlacesData = """
src = HEADER + json.dumps(data, separators=(',',':')) + ';\n'
open(OUT,'w').write(src)
print(len(keep), len(src))
