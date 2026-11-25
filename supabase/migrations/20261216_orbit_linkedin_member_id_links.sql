-- LinkedIn links stored with a lowercased member id ("https://www.linkedin.com/in/acoaab...") open LinkedIn's
-- "This page doesn't exist": a member id only works in its own case. The URL normalizer lowercased every slug until
-- now; it keeps a member id's case from here on (packages/core/src/text/normalize.ts). This repairs the links already
-- stored, from the person's own member id, which kept its case. Only a link that is exactly that id in another case
-- changes; linkedin_slug (the lower-case matching key) is left as it is. touch_updated_at sends the fixed rows to the
-- browser. Additive data repair: no columns change, nothing is removed.

update orbit.people
   set linkedin_url = 'https://www.linkedin.com/in/' || linkedin_member_id
 where linkedin_member_id ~ '^ACoAA[A-Za-z0-9_-]{20,}$'
   and linkedin_url is not null
   and lower(rtrim(linkedin_url, '/')) = lower('https://www.linkedin.com/in/' || linkedin_member_id)
   and rtrim(linkedin_url, '/') <> 'https://www.linkedin.com/in/' || linkedin_member_id;
