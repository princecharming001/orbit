# 43. Instagram, X and texts in the warm path engine

Orbit finds warm paths from LinkedIn and Gmail today. This plan adds Instagram, X and iMessage as three more places
Orbit can learn who a student knows, how well, and who those people know. Each one can be switched on or off on its
own, and every combination has to work.

Nothing here is built yet. Section 12 lists what a short test on a real account has to confirm before each part starts.

## 1. What each place can give

| | Instagram | X | iMessage |
|---|---|---|---|
| How Orbit reads it | Unipile, signed in as the student (the same service as LinkedIn) | X's own API, the student signs in with X | The student picks their Messages file; it is read in the browser |
| Who the student knows | Who they follow, who follows them, who they DM | Who they follow, who follows back, who they DM | Who they text |
| Who knows a target | The target's followers and following | The target's followers and following | Nothing. Texts hold no one else's connections |
| How close | DMs, following each other | DMs (last 30 days only), following each other | Texts, the strongest signal Orbit can get |
| Live updates | Yes, Unipile sends each new message | Yes, by asking X once a day, or paid events | No. The student re-reads the file |
| Sending | Yes, with the student's tap | Yes, with the student's tap | Opens Messages with the draft written |
| Cost | One Unipile seat, about 3 to 5 euros a month | $0.01 per person or message read | Free |
| Hard limit | About 100 actions a day, 10 an hour | Money, and X's policy on matching people | Mac only |

Three facts shape everything below:

- **Instagram gives a count before the list.** A profile read returns how many of the target's followers the student
  follows. That is one call, and when it is zero Orbit stops. LinkedIn works the same way today.
- **X charges per person returned,** so the plan for X is about not reading the same list twice.
- **Texts never show a path to a stranger.** They make the first step of a path trustworthy: they tell Orbit which
  bridge is a real friend.

## 2. One base under all three

Seven pieces are shared. Building them once is what makes "any combination" work.

### 2.1 Sources and switches

A **source** is one place Orbit reads: `linkedin`, `gmail`, `calendar`, `instagram`, `x`, `texts`. One registry in
`@orbit/core` (`sources.ts`) says, for each source: its name, which touch kinds, tie kinds, identity kinds and message
providers belong to it, and what it can do (people, messages, mutuals, sending).

There are two switches.

1. **Yours, for the whole product.** A setting on the server (`ORBIT_SOURCES`, for example `instagram,texts`) says
   which sources exist in Orbit at all. A source that is not listed appears nowhere: no row in Settings, no step in
   onboarding, no tool in the chat, no job on the server. You can ship Instagram alone, then add X, in any order.
2. **The student's, per source.** In Settings, under Network, each source is one row with one switch.

A source is in one of four states for a student:

| State | Meaning | Orbit reads from it | Counts in closeness and paths | Data kept |
|---|---|---|---|---|
| Not connected | Never set up | No | No | None |
| On | Connected and in use | Yes | Yes | Yes |
| Off | Connected, switched off | No | No | Yes |
| Removed | The student chose "Remove what Orbit took" | No | No | Deleted |

Off costs nothing to undo: switching back on brings everything back at once, with no re-import. An Instagram account
left off for 21 days is released at Unipile so its seat stops costing money, exactly as LinkedIn is parked today; the
student signs in again when they switch it back on.

### 2.2 The off rule: filter, never delete

Every row Orbit keeps from a source says which source it came from. Scoring and path finding ask one function,
`sourcesInUse(user)`, and ignore rows from any source not in the answer.

- Closeness: touches and messages from an off source are left out before the score is computed. Switching a source
  queues one rescore of the student's people.
- Paths: ties from an off source are left out when the graph is built. Paths are computed on request, so there is
  nothing to rebuild.
- Identity: a merge that only an off source supports stays (un-merging people on a switch would be destructive and
  confusing). The handle is hidden while the source is off.
- Calls: an off source makes no calls and runs no jobs.
- Drafts: an off source is not offered as a way to send.

One test holds the whole design together, the **removal test**: for any set of sources switched off, closeness and
paths must be identical to what Orbit would compute if those sources' rows had never existed. It runs over generated
people and over every one of the 32 on/off combinations of the five sources that carry people.

### 2.3 Accounts are not people

A student follows about 800 Instagram accounts: friends, brands, meme pages, athletes. Putting all of them in People
would bury the real ones. So there is a layer under People.

- A **social account** is one account on one platform: its id, handle, name, bio, links, counts and flags. It lives in
  a shared table, like the shared LinkedIn person record does today.
- A **person** is someone in the student's People. An account is attached to a person only when Orbit is sure they are
  the same human (2.4).
- An account becomes a new person by itself only when it is plainly a friend: it reads as an individual, the student
  and the account follow each other, and they have messaged. Everyone else stays an account and is never shown in
  People.

Each account is first sorted into one of four kinds, because only a person can be a bridge or a target:

| Kind | How Orbit tells | Used as |
|---|---|---|
| Person | A real first and last name, not a business profile, a modest following | Bridge, target, match candidate |
| Public figure | Verified, or a very large following | Never matched by guesswork, only by a direct link |
| Brand | Business category, a name that is not a person's | Ignored for paths |
| Unknown | No name, no bio | Kept as an account, never matched |

### 2.4 The same person in two places

This is the piece that decides whether the rest is right. If Orbit wrongly decides `@jchen_22` is the Jason Chen at
Stripe, it invents a path that does not exist.

Orbit already has an engine for this (`resolveIdentity`): exact keys first, then a score that ends in merge, ask the
student, or keep apart. It has a labelled test set that holds automatic merges to zero mistakes. This plan extends that
engine. It does not build a second one.

**Step 1. Exact links. These attach on their own.**

| Link | Where it comes from |
|---|---|
| The handle is already attached to someone | A new identity kind per platform (`instagram_id`, `instagram_username`, `x_id`, `x_username`) |
| The person's LinkedIn profile lists the handle | LinkedIn's "websites" and contact details. Orbit already receives these and throws them away today |
| The account's bio or links point at the person's LinkedIn | The profile read |
| The account lists an email or phone Orbit already has for the person | Business contact details on the profile |
| The student's address book lists the handle on that contact's card | The contact file used for texts |
| Orbit's research already confirmed a page of theirs that links to the handle | The research loop collects these and discards them today |
| The student said so | The confirm card below |

**Step 2. A score, when there is no exact link.** Candidates are people whose name could fit the account's name or
handle. Each pair gets these signals:

| Signal | What it measures |
|---|---|
| Name | The account's display name against the person's name, with the matcher Orbit has (nicknames, accents, order) |
| Handle spells the name | `jason.chen22` against Jason Chen, with the same patterns Orbit uses on email addresses |
| Bio names their employer | "SWE @stripe" against Stripe, with the employer aliases Orbit has |
| Bio names their school | "Stanford 25" against Stanford |
| Bio fits their role | Words shared with their title |
| Place | The city on both |
| Same link | Both point at the same personal site |
| Same picture | The two profile pictures are the same image |
| In the student's circle | The student and the account follow each other or message. Someone you talk to is likely someone you know |
| Shared neighbours | People already matched who are tied to both the person and the account. Two or more is strong |
| Rare name | "Anish Polakala" is one person. "Jason Chen" is thousands |
| Against: public figure | A verified account with a huge following against a person with a small one is a namesake |
| Against: another handle | The person's own profile lists a different handle on this platform |

Three rules sit on top of the score, as they do today:

- A name alone never attaches anything. An automatic match needs one signal that does not come from the name: employer,
  school, same link, same picture, or two shared neighbours.
- If two people could fit one account, Orbit asks. It never picks.
- A public figure, a brand or an unknown account is never matched by score.

**Step 3. Three outcomes.**

| Score | What happens |
|---|---|
| Exact link, or very high with independent proof | Attached. The person's page shows the handle |
| Middle | A card: "Is @jchen_22 on Instagram the Jason Chen you know from Stripe?" with the evidence for and against. Yes attaches it for good. No is remembered and never asked again |
| Low | Left apart |

"Same picture" means the same image file, compared by a fingerprint of the picture. It does not mean recognising a face.
Face matching is biometric data under several laws, and this plan does not use it.

**Finding a target's handle.** Paths to a target through Instagram need the target's Instagram account. Orbit looks,
in order: a handle already attached, the target's LinkedIn websites, handles from research, then a search on the
platform by name, scored as above. It does this only for people the student is going after, and it spends from a
small daily budget. When nothing is found with confidence, Instagram adds no path to that person, and the path card
says nothing about Instagram.

**How this is tested.** Section 7.2. In short: scored matches start as "ask the student" only, and automatic matching
by score is switched on only after it is measured on real accounts.

### 2.5 Where the follow graph is kept

Three tables, the same for Instagram and X.

| Table | Holds | Who can use it |
|---|---|---|
| `social_accounts` | One row per account Orbit has a reason to know: public profile fields, kind, when it was read | Shared across students, like LinkedIn person records. Public fields only |
| `social_follows` | One row per "A follows B", as two ids and a date | Rows read from a public account's list are shared. Rows from a student's own lists belong to that student |
| `social_list_reads` | For each account and list (followers or following): how much was read, whether it was complete, when | Shared for public lists |

The third table matters more than it looks. A missing row in `social_follows` means "does not follow" only if that
list was read to the end. Without the record of what was read, Orbit would report "no mutuals" for a list it only read
the first page of.

To keep as little as possible about people who never signed up: a list read stores ids only. Orbit fetches a name and
a profile only for an account that turns out to matter, meaning it is in a student's own circle or it is a bridge.

A student's own relations are also kept per student (`i_follow`, `follows_me`, first and last seen), because closeness
needs them and because they are private to that student.

### 2.6 Finding mutuals

A **bridge** between the student and a target is an account the student has a real tie to and that has a tie to the
target. Direction matters on platforms where following is one way:

| Between the bridge and the target | Meaning | Use |
|---|---|---|
| They follow each other | They likely know each other | A path |
| The target follows the bridge | The target pays attention to them | A path, weaker |
| Only the bridge follows the target | A fan | Never a path by itself. It can support another tie |

The lookup for one student and one target runs in this order and stops at the first step that answers:

1. **Is the source on, and does Orbit know the target's account?** If not, stop.
2. **The kept answer.** The last answer for this student and target, kept 14 days, as LinkedIn mutuals are.
3. **The graph Orbit already holds.** If the target's lists were read to the end in the last 30 days, by any student,
   the mutuals are one indexed query over `social_follows` joined with the student's own relations. No calls.
4. **The count.** One profile read. A private account the student does not follow: stop, and say so. A count of zero:
   keep "none" for 14 days and stop.
5. **The smaller list.** Read whichever of the target's two lists is shorter. For most people that is who they follow,
   and it is also the more useful direction. Store the rows, mark the read complete or partial.
6. **The other list, if needed.** Only when the count says there are more than were found, and only up to a fixed
   number of pages. Stop as soon as the number found equals the count.
7. **Keep the answer,** write the ties, and mark it partial if Orbit stopped early.

Why this is the cheapest order: steps 2 and 3 cost nothing and get more likely with every student who joins, because
students at one school chase the same people. Step 4 turns most lookups into one call. Steps 5 and 6 are paid once per
target per month across all of Orbit.

**The free graph.** When the bridge is an Orbit student who connected the same source, Orbit already holds their own
lists, so "does Maya follow the target" needs no call at all. This uses one student's lists to answer another's
question, so it only happens between Orbit friends who have sharing on, under the sharing rules that exist today.

### 2.7 How this enters warm paths

Path finding does not change shape. It gains evidence.

- Two new tie kinds, `instagram_mutual` and `x_mutual`, sit beside `linkedin_mutual`. They enter `rankWarmPaths` as
  outside candidates the same way LinkedIn mutuals do.
- **Evidence about the same pair adds up.** If Maya and the target are connected on LinkedIn and also follow each
  other on Instagram, the engine already combines the two into one stronger tie (each piece of evidence cuts the
  remaining doubt). This is why matching people across platforms (2.4) is the centre of the plan: without it Maya on
  LinkedIn and Maya on Instagram are two weak bridges, with it she is one strong one.
- **The weight of a follow depends on how selective the follower is.** A target who follows 150 accounts and follows
  Maya very likely knows her. A target who follows 5,000 may not. The tie weight starts near LinkedIn's (0.3 for
  following each other) and is scaled down as the follower's following count grows.
- **The first step uses closeness as now.** How likely the bridge is to help comes from the student's closeness to
  them, which now includes Instagram, X and texts (2.8).
- **The words name the platform.** "Maya and Priya follow each other on Instagram." "Priya follows Maya on X." X's
  rules require that a follow shown to a user is labelled as coming from X.
- A path that rests only on a one-way follow is marked a weaker route, the way a faint LinkedIn mutual is today.

The same change is made in both places paths are computed: the server (`findPaths`, for signed-in students) and the
browser (`reachPerson`, for the demo and local use).

### 2.8 Closeness

Closeness is one model that reads messages, meetings and ties and does not care which channel a message came from.
That stays. What is added:

| Addition | Detail |
|---|---|
| New message channels | `instagram` and `x` join `email`, `linkedin`, `text` |
| One touch per day each way | As LinkedIn DMs and texts are counted today. Fifty messages in one evening is one day of talking, which stops chatty apps from swamping email |
| A message has to be a message | A day counts when words were written. A day of only reactions or forwarded posts counts as light engagement, like a LinkedIn reaction |
| Group chats | A chat of more than three people is not a conversation with each of them. Small groups add a little to each member, as a small meeting does |
| Following each other | A new signal beside "connected on LinkedIn". One-way follows count for much less. It gets its own weight so existing scores do not shift |
| Requests | A message from someone the student never answered counts for nothing, by the rule that one-sided contact is capped |
| Reply tone | The reader that judges how warm a reply is already takes any text. It gets the new channels |

**Different plumbing per source, one shape at the end:**

| Source | How messages arrive | Where they land |
|---|---|---|
| Instagram | Unipile calls Orbit's existing webhook for every new message. Past chats are pulled once at connect | `threads` and `messages`, provider `instagram` |
| X | Orbit asks X for new DM events once a day for active students. The first read covers 30 days, which is all X gives | `threads` and `messages`, provider `x` |
| Texts | The browser reads the file and keeps the words there | Day counts only (decision 1 in section 11) |

**The gap this fixes.** For a signed-in student, closeness is computed on the server, and texts never reach the
server, so texts count for nothing today. The fix proposed is to send only the numbers: for each person, each day,
how many texts each way. The words stay in the browser. This changes what Orbit says about texts, so it is your call.

**How it is checked.** Students already tell Orbit how close they are to some people. Before a source's weights ship,
Orbit's ordering of people is compared with those answers, with and without the source. A source may not make the
ordering worse.

### 2.9 Plumbing that is LinkedIn-only today

Each of these is widened once, by adding and never by changing what exists:

| Today | Becomes |
|---|---|
| An account row may be `google`, `linkedin` or `village` | Also `instagram`, `x`, `texts` |
| A message may come from `gmail` or `linkedin` | Also `instagram`, `x` |
| An identity may be an email, LinkedIn id, phone | Also the four handle kinds |
| A tie kind list without social follows | Also `instagram_mutual`, `x_mutual` |
| The connect link asks Unipile for LinkedIn | Takes the provider as an input |
| The Unipile webhook looks up a LinkedIn account | Looks up whichever account the event names |
| Daily call budgets keyed for LinkedIn | A budget per source, with its own kinds and limits |
| The shared store and the call counts are LinkedIn tables | New tables with a source column beside them. The LinkedIn ones stay as they are |
| A draft goes by Gmail or LinkedIn | Also Instagram, X, or "open in Messages" |
| Readiness tracks LinkedIn and email steps | A step per source that is on |

## 3. Instagram, complete

**Connect.** The student turns Instagram on, sees what Orbit will read and the risk note (section 8), and signs in on
Unipile's page with their Instagram username and password, plus a code if they use two-step sign in. Sign in with
Facebook is not supported by Unipile.

**First day, inside the budget.** About 100 calls a day and 10 an hour, spaced unevenly:

| Order | What | Calls |
|---|---|---|
| 1 | The student's own profile | 1 |
| 2 | Who the student follows | A few |
| 3 | Their chats, and recent messages in each one-to-one chat | About 20 |
| 4 | Who follows the student | 25 at a time, spread over the following days |

The student can use Instagram paths as soon as steps 1 to 3 are done, usually within the hour. Step 4 fills in who
follows back; until it finishes, a DM history stands in as proof of a two-way tie.

**Budget shares.** The student's own request for a path can use the whole day's budget. Background work is capped:
own-list refresh 30 percent, finding handles 30 percent, history 40 percent. When the day's budget is gone, Orbit says
it carries on tomorrow, as it does for LinkedIn.

**Ongoing.** New messages arrive by webhook at no cost in calls. The student's own lists are refreshed a page at a
time, at uneven intervals, never at a fixed hour, because Unipile warns that fixed schedules get accounts flagged.

**People.** Each one-to-one chat partner and each account the student follows back goes through 2.3 and 2.4: matched
to someone in People, proposed as a match, made a new person if plainly a friend, or left as an account.

**Mutuals and paths.** As 2.6 and 2.7. Lists come 25 at a time for followers. A verified target returns only a small
sample of followers, so for verified targets Orbit reads who they follow instead and says the answer may be partial.

**Sending.** Instagram becomes a way to send a draft. It never sends by itself: every message needs the student's tap,
the rule LinkedIn has. A daily cap of 10. A message to someone who does not follow the student lands in their
requests, and the draft box says so before sending. If the account is not connected, "Open in Instagram" opens the
chat and copies the draft.

**Replies.** An inbound message on a chat where the student is waiting moves it to "replied", as a LinkedIn reply does.

**When it breaks.** Instagram sometimes asks the student to confirm it is them. Unipile reports that; the row shows
"Sign in again", the student gets one notice, and everything else in Orbit carries on.

**Where it shows.**

- Settings: the Instagram row, with its switch, last read, and "Remove what Orbit took".
- Onboarding: an optional step after LinkedIn.
- Chat: "connect my Instagram" shows the setup card; "who knows Priya" includes Instagram bridges.
- Person page: the handle as a link, the Instagram messages in the Messages tab, the confirm card for a proposed match.
- Map and path cards: the bridge's line names Instagram.
- Readiness: "Reading who you follow" and "Reading your messages".

## 4. X, complete

**Connect.** The student signs in with X in the browser. Orbit asks for: read profile, read follows, read DMs, send
DMs, stay signed in. A consent screen before that says exactly what is stored, because X's rules require consent to
store DMs beyond the sign in itself. Orbit needs its own X developer app and prepaid credits, which you set up.

**What it costs to read, and the plan to read little.**

| Read | Price | How Orbit keeps it small |
|---|---|---|
| Who the student follows | $0.01 a person | Read once. Each returned account also says whether it follows the student back, so the followers list is not read at all. To confirm in the test |
| DMs | $0.01 a message | The first 30 days, capped. Then new ones once a day |
| A target's profile | $0.01 | Kept 30 days, shared |
| A target's list | $0.01 a person | The shorter list, capped at 200 people, shared across students for 30 days |
| Sending a DM | $0.015 | With the student's tap |

Every dollar spent is counted against the student in a monthly budget (5 dollars to start). At the limit Orbit asks
before reading more. A second limit covers all of Orbit for the month and switches X reads off when it is reached, so
a bug cannot run up a bill. Credits are prepaid, which caps the worst case at what you loaded.

**Mutuals and paths.** As 2.6, with one difference in step 3 and 5: X returns up to 1,000 people a page, so a list is
a few calls, and money is the limit instead of the call count. X has no "followers you know" count, so step 4 becomes
a check of the two totals to pick the shorter list. Protected accounts are never read.

**Matching people.** As 2.4, with X's rule on top: an X account may be tied to a real identity only from public
information, from what the person gave Orbit, or with their consent. The exact links and the public bio signals fit
that. Orbit does not use anything bought or scraped from third parties to match an X account.

**Closeness.** X gives only 30 days of DMs, so X adds little history at first and grows over time. For most students
X will matter more for who follows whom than for closeness.

**Keeping it current.** X requires stored data to follow the platform: an account that goes protected or is deleted
has to be removed. A job re-checks kept accounts and lists as they expire and drops what is gone. A removal request
is honoured within a day.

**Sending.** With the student's tap only. Before a draft is offered on X, Orbit checks whether that person accepts DMs
from the student, which X reports on the profile.

**Where it shows.** The same places as Instagram, with "on X" in every line about a follow.

**A limit to know.** X describes pay per use as meant for early stage products with limited users. It suits Orbit now.
At a few thousand connected students it means a conversation with X about a contract.

## 5. Texts (iMessage), complete

**What exists.** The engine that reads a Messages file, names people from the student's contacts, counts a touch per
day each way and proposes "replied" is written and tested. No screen calls it, so students cannot use it today.
Correcting what I said earlier: it is built, and it is not reachable.

**What gets built.**

| Piece | Detail |
|---|---|
| The screen | A Texts row in Settings and an optional onboarding step, on Macs only. Two guided steps: pick the Messages folder, pick an exported contacts file |
| Reading the newest messages | Messages keeps the last few days in a side file. Orbit reads the folder, not the single file, so those days are not missed |
| Update | In Chrome and Edge the browser can remember the folder, so "Update texts" is one click. In Safari the student picks it again. Orbit reminds them when a chat is waiting on a reply |
| Group chats | Read for groups of up to eight. Each member gets a little closeness. Larger groups are skipped as now |
| Handles from contacts | A contact card that lists an Instagram or X handle gives an exact link (2.4) |
| Signed-in students | Day counts go to the server so texts count in closeness (decision 1) |
| Sending | "Open in Messages" opens the conversation with the draft written. The student sends it. Orbit marks it sent and looks for the answer on the next update |

**What texts do for paths.** They add no bridges. They make the first step of every path honest: a bridge the student
texts weekly ranks above one they connected with once on LinkedIn. They also give phone numbers, which are exact keys
for matching people.

**Not on a Mac.** Without a Mac there is no Messages file, so the row is hidden. A live connection that reads and
sends from the student's own number needs software on the Mac and is outside this plan.

## 6. Every place this touches

So nothing is left half done, each source goes through the same list before it counts as finished:

- [ ] Settings row, switch, states, remove
- [ ] Onboarding step, optional
- [ ] Chat: setup card, tools, capability list, what the model is told is connected
- [ ] Readiness steps and the "Orbit is ready" notice
- [ ] People: matching, the confirm card, the handle on the person page, merge and un-merge carry the handles
- [ ] Messages tab and the last messages on a person's page
- [ ] Closeness, on the server and in the browser
- [ ] Mutuals: lookup, kept answer, "People who know" list
- [ ] Paths: server and browser, the words, the weaker-route mark
- [ ] Discover and sourcing: the "intro possible" tier can name a bridge from the new source
- [ ] Drafts: the channel, the send rule, caps, the fallback link, the touch written on send
- [ ] Replies and stage moves
- [ ] Friends: handle keys in what friends share, and what is left out of the score a friend sees
- [ ] Budgets, call counts, the cost view
- [ ] Parking an idle account, signing in again, account deletion
- [ ] Privacy screen and policy
- [ ] Demo data and the fake account, so the demo shows it and tests can drive it

## 7. Testing

### 7.1 Combinations

- The removal test (2.2) over all 32 combinations.
- For every combination: readiness reaches "ready", the path card renders, a draft can be written and sent or handed
  off, and no request goes to a source that is off.
- Switching a source off and on returns exactly the earlier scores.

### 7.2 The matching engine

| Test | What it proves | Bar |
|---|---|---|
| A labelled set of account and person pairs, in the style of the set Orbit has for people | The rules decide right | No wrong automatic match. At least 150 pairs, more than 60 of each answer |
| Traps in that set | The known ways to be wrong | Namesake at another school, a celebrity with the same name, a second private account, a handle with no name, a name in another script, a nickname handle, a photographer's business page, a parody account, a common name with the same employer |
| The account kind sorter | Brands and public figures never become bridges | No brand or public figure sorted as a person in the set |
| Your own accounts, labelled by hand, kept out of the repository | It works on real data, not only on cases I thought of | Measured before automatic matching is switched on |
| In production | It stays right | The share of "No" answers on confirm cards, and a small sample of automatic matches shown for confirmation |

Scored matches ship as "ask the student" only. Matching by score without asking is switched on per platform after the
real-data check shows at least 98 in 100 right on 200 or more pairs. Exact links attach from day one.

### 7.3 Mutuals and paths

- A fake platform with a known graph: every bridge found, none invented, for complete and partial lists.
- "No mutuals" is never reported from a list that was not read to the end.
- The order of the lookup: a kept answer or a held list makes no call; a zero count makes one.
- Sharing: a second student asking about the same target makes no call. A student's own lists never answer another
  student's question unless they are friends with sharing on.
- Path ranking: a bridge on two platforms outranks the same bridge on one. A one-way follow never makes a path alone.

### 7.4 Closeness

- Per-day counting, the words rule, group chats, requests.
- The comparison with students' own answers (2.8).
- Existing scores for a student with no new source do not move at all.

### 7.5 Budgets and failure

- Instagram's daily and hourly limits hold under load, and the student's own request is never starved by background
  work.
- X spend stops at the student's limit and at Orbit's limit.
- Each source failing (sign in lost, credits gone, service down) leaves every other source working.

### 7.6 End to end

The demo account gets a fake Instagram, X and Texts. Tests connect each, find a path through each, send through each,
switch each off, and check the app at phone and desktop sizes.

## 8. Privacy, rules and risk

| Risk | What the plan does |
|---|---|
| Instagram does not allow automation. An account can be warned or restricted | Orbit says so plainly before connecting. It reads far more than it writes, stays under Unipile's limits, spaces calls unevenly, and never sends without a tap |
| Orbit would hold follow lists of people who never signed up | Ids only for list rows. Profiles only for accounts that matter. Lists expire after 30 days. Private accounts' lists are never shared |
| A wrong match invents a path | Section 2.4 and 7.2. A wrong match can be undone from the person's page |
| X's rules on matching, storing DMs, labelling follows and keeping data current | Sections 2.7 and 4. Worth a read by a lawyer before X goes live |
| One student's network leaking to another | Own lists are private. Cross-student use only between friends with sharing on. X data and texts are left out of the score a friend sees |
| Texts are the most private thing Orbit touches | The words never leave the browser. Only counts go to the server, if you approve it |
| A student wants out | Off stops reading at once. Remove deletes what was taken, including rows in the shared graph that came from their own lists |

The privacy screen and the policy are rewritten to name each source, what is read, what is shared, and for how long.
One thing found on the way: the policy says shared public reads are kept up to 1 day, and the code keeps them 30 days.
That is wrong today and gets fixed with this work.

## 9. Cost

| Source | Per student a month | What drives it | The lever |
|---|---|---|---|
| Instagram | 3 to 5 euros | A Unipile seat while connected | Park idle accounts after 21 days. Connect only when switched on |
| X | About 3 to 6 dollars, capped | People and messages read | Shared lists, the per-target cap, the monthly limit |
| Texts | Nothing | | |

The Unipile seat prices come from third-party write-ups and should be confirmed with Unipile. X usage is my estimate.

## 10. Build order

Each stage ends with something that works and can be switched on alone.

| Stage | What | Size | Ends with |
|---|---|---|---|
| 0 | Three short tests on real accounts (section 12) | Small | The unknowns answered |
| 1 | The base: sources and switches, the off rule and its test, handles in identity, the widened plumbing | Large | Nothing new visible. LinkedIn and Gmail unchanged, proven by tests |
| 2 | Texts: the screen, the newest messages, groups, day counts for signed-in students | Medium | Texts count in closeness for everyone on a Mac |
| 3 | Instagram messages and people: connect, webhook, history, matching as "ask" | Large | Instagram counts in closeness |
| 4 | Instagram graph: own lists, the mutual lookup, the shared graph, paths | Large | Paths through Instagram |
| 5 | Instagram sending and replies | Medium | Instagram complete |
| 6 | X: connect, budget, lists, mutuals, paths, DMs, sending | Large | X complete |
| 7 | Friends across platforms, cost view, policy, automatic matching after the real-data check | Medium | Everything in section 6 ticked for all three |

Texts come first because the engine exists and it costs nothing to run. Instagram comes before X because it is where
students' real friends are and because its cost is fixed. Stages 2 and 3 can run side by side once stage 1 is in.

## 11. Decisions for you

I will go with the recommendation on each unless you say otherwise.

1. **Texts for signed-in students.** Send per-person, per-day counts to the server, never the words. Recommended yes.
   Without it, texts cannot count for anyone with an account.
2. **Using one student's follow lists to answer another's question.** Only between Orbit friends with sharing on.
   Recommended. The alternative is never, which is safer and finds fewer paths.
3. **Instagram's risk.** Go ahead with a plain warning to the student, reading first, and sending only by tap.
   Recommended.
4. **X spending.** A developer app, prepaid credits, 5 dollars a student a month to start. This costs money, so I will
   ask again before anything is bought or switched on.
5. **Pictures.** Same image only, no face matching. Recommended.
6. **LinkedIn and Gmail switches.** The base gives them the same on and off switch for free. Recommended to show it,
   so all five behave the same way.

## 12. What a short test has to confirm first

These are things the documentation leaves unclear. None changes the design; each changes a number or a step.

**Instagram, on your own account through Unipile**

- How many accounts one call to the following list returns, and whether it needs the student's own id.
- Whether a target's follower list comes back with the accounts the student follows first. If it does, mutuals are
  one or two calls.
- That the mutual count on a profile means what I take it to mean.
- How far back chat history goes, whether message requests appear, and how group chats come back.
- Whether there is a search by name, for finding a target's handle.
- How often Instagram asks the account to confirm itself under this use.

**X, with a developer app and a few dollars of credit**

- That each account in the student's following list reports whether it follows back.
- Whether a protected account's lists can be read at all.
- That daily asking for new DMs is enough, against paying per event.

**Texts, on a Mac**

- Whether the browser can open the Messages folder directly, or the student has to copy it first.
- That the side file with the newest messages reads correctly.
