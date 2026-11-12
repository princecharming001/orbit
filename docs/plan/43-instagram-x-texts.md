# 43. Instagram, X and texts in the warm path engine

Orbit finds warm paths from LinkedIn and Gmail today. This plan adds Instagram, X and iMessage as three more places
Orbit can learn who a student knows, how well, and who those people know. Each can be switched on or off on its own,
and every combination has to work.

Nothing here is built. This is the second version: the first was checked against the code by an independent review,
which found thirteen places where it would have failed. Each is fixed below, and section 14 lists what changed.

## 1. What each place can give

| | Instagram | X | Texts (iMessage) |
|---|---|---|---|
| How Orbit reads it | Unipile, signed in as the student (the service LinkedIn uses) | X's own API, the student signs in with X | The student picks their Messages file; the browser reads it |
| Who the student knows | Who they follow, who follows them, who they DM | Who they follow, who follows back, who they DM | Who they text |
| Who knows a target | The target's followers and following | The target's followers and following | Nothing. Texts hold no one else's connections |
| How close | DMs, following each other | DMs (last 30 days only), following each other | Texts, the strongest signal there is |
| Live updates | Yes. Unipile sends each new message | By asking X on a schedule | No. The student re-reads the file |
| Sending | With the student's tap | With the student's tap | Opens Messages with the draft written |
| Cost | One Unipile seat, about 3 to 5 euros a month | $0.01 per person or message read | Free |
| Hard limit | About 100 actions a day, 10 an hour | Money, and X's rules on matching people | Mac only |
| Where it runs | Signed-in students only | Signed-in students only | Everyone on a Mac |

## 2. Three things to know before anything else

**1. Knowing which Instagram account is the target's is the hard part, and it decides how much Instagram is worth.**
To find who knows Priya on Instagram, Orbit must first know which account is Priya's, with near certainty. The student
cannot confirm it, because the student does not know Priya. So for targets Orbit can only use hard proof: her LinkedIn
lists the handle, her Instagram links to her LinkedIn, or a page of hers that Orbit's research confirmed links to it.
Many working professionals show none of these. Expect Instagram paths to work well for people near the student's age
(students, recent graduates, founders) and rarely for a senior stranger. The first test in section 13 measures this
on real targets before the graph work is built. If the number is low, Instagram is still worth building for closeness,
which needs no target handle at all.

**2. Instagram and X work only for signed-in students.** Their messages arrive on Orbit's server, their budgets are
kept there, and the graph is shared there. The logged-out demo shows them with made-up data. Texts work everywhere.

**3. X is the most expensive path Orbit can find.** About 5 dollars to connect, about 4 dollars in any month it is
used, and 2 to 10 dollars for each new person checked. The plan makes X something the student asks for one person at
a time, with the price shown first. It is built last, and it is reasonable to decide after Instagram whether to build
it at all.

## 3. One base under all three

### 3.1 Sources and switches

A **source** is one place Orbit reads. LinkedIn, Gmail and Calendar are always part of Orbit and keep the connect and
disconnect they have. The three new ones are **optional sources**: `instagram`, `x`, `imessage` (shown as "Texts").
One registry in `@orbit/core` says, for each: which message providers, touch kinds, tie kinds and identity kinds
belong to it, and what it can do.

**Your switch, for the whole product.** A server setting lists which optional sources exist (`ORBIT_EXTRA_SOURCES`,
for example `instagram,imessage`). The web app is built with the same list. An optional source that is not listed
appears nowhere. If you later take one away while students have it connected, it goes off for everyone: reading stops
at once, students are told once, Unipile seats are released after 21 days, and what was taken is kept 30 days in case
you turn it back on, then removed.

**The student's switch, per source.** One row per source in Settings, under Network, with one switch.

| State | Orbit reads from it | Counts in closeness and paths | What Orbit took |
|---|---|---|---|
| Not connected | No | No | Nothing |
| On | Yes | Yes | Kept |
| Off | No | No | Kept, hidden |
| Removed | No | No | Deleted |

What Off and Removed do to each kind of thing:

| Thing | Off | Removed |
|---|---|---|
| Messages from the source | Kept, hidden, not counted. New ones are not stored while off | Deleted |
| Who follows whom, and ties built on it | Kept, hidden, not used | Deleted, including the student's own rows in the shared graph |
| A handle attached to a person | Hidden | Deleted. The student's "No, not the same person" answers are kept so they are not asked again |
| A person only this source knows | Hidden from People and paths | Deleted, unless the student has a chat or a note with them. Then the person stays without the handle |
| A chat that moved to "replied" because of a message there | Stays where it is. The pipeline is the student's | Stays. The evidence line says the source was removed |
| A draft waiting to go out on that channel | Paused with a note. The student can pick another way to send | Becomes an unsent draft to copy |
| Things said in past chats with Orbit | Unchanged | Unchanged |

Switching back on after Off brings back everything kept, then reads what arrived while it was off. An Instagram
account left Off for 21 days is released at Unipile so its seat stops costing money, and the student signs in again to
switch it on. That reuses the job that parks LinkedIn today, which fires when a student has been away 21 days; it gets
a second trigger.

One account per platform per student. Signing in with a different account asks first ("This is a different Instagram
account. Replace the old one?") and then removes what came from the old account before reading the new one.

### 3.2 The off rule, and how it is enforced

The first version said "everything asks one function and filters". The review showed why that is not enough: scores
are stored, ties are read in about a dozen places on the server, the friend projection is rebuilt nightly, and the
browser caches its graph. So the rule is enforced in three ways together.

1. **Every row from an optional source says so.** Messages by provider, ties by kind, touches by kind, identities by
   kind, and each also carries the id of the social account it came from (3.4 needs that too).
2. **Every place that reads those rows goes through one helper** that leaves out sources that are off. On the server
   that is: scoring (messages, intros, neighbours), the three ways paths load ties, the job that weighs bridges, what
   friends are shown, the context given to drafts, cadence, the autopilot plan, notices, and what is sent to the
   browser. In the browser: the graph, the conversation view, closeness, the person page. The list is a checklist in
   the build, and the removal test below fails if one is missed.
3. **A switch runs one job** that does all of: a full rescore of the student's people (two passes with a refit,
   because a person's score depends on their neighbours' scores), the friend projection, Discover's reach numbers, and
   a signal that makes the browser drop its cached graph. The quick rescore Orbit normally runs would do nothing here,
   because no row changed.

**The removal test.** For each of the 8 on and off combinations of the three optional sources, on a student with
LinkedIn and Gmail and on a student with neither: run every entry point (closeness, paths, "who knows", the draft
context, the friend projection, what the browser receives) and compare with a second, freshly built student that never
had the off sources' rows, scored by the same job with the clock fixed. They must match.

One stated exception: people Orbit merged because of evidence from a source stay merged when it goes off. Splitting
people apart on a switch would be destructive and confusing.

### 3.3 Accounts sit under people

A student follows about 800 Instagram accounts. Most are not people the student knows. So there is a layer under
People.

- A **social account** is one account on one platform, known by the platform's own id. The handle is a label that can
  change, never the key.
- A **person** is someone in the student's People. A person can have several accounts on one platform.
- An account is **attached** to a person when Orbit is sure they are the same human (3.4).

Each account is sorted into a kind, because only a person can be a bridge:

| Kind | How Orbit tells | Used as |
|---|---|---|
| Person | A real first and last name, not a business profile, a modest following | Bridge, target, match candidate |
| Public figure | Verified, or a very large following | Attached only by hard proof |
| Brand | A business category, a name that is not a person's | Ignored for paths |
| Unknown | No name, no bio | Kept as an account, never matched |

**When an account becomes a person.** Paths and ties in Orbit only work between people, so an account that is going
to be a bridge needs a person row. That happens at two moments, and only for accounts sorted as a person:

- when the student and the account message each other both ways, or
- when a lookup finds the account is a bridge to a target (3.6).

Everything else stays an account. A person made this way is marked as coming from that source, appears under People
only once the student has a real exchange with them, and can be attached to a LinkedIn person later.

**Their closeness.** A bridge whose only link to the student is following each other still has to count as a first
step. Following each other makes the tie exist, the way "connected on LinkedIn" does today, and path finding lifts
such a bridge to the same minimum a LinkedIn mutual gets. The path is marked a weaker route until there is more.

### 3.4 The same person in two places

If Orbit wrongly decides `@jchen_22` is the Jason Chen at Stripe, it invents a path that does not exist. This extends
the engine Orbit has (`resolveIdentity`) and keeps its rule that a wrong automatic match is not acceptable.

**Hard proof. These attach on their own.**

| Proof | Where it comes from |
|---|---|
| The account id is already attached to someone | A new identity kind per platform |
| The person's LinkedIn profile lists the handle | LinkedIn websites and contact details. Orbit receives these and discards them today |
| The account's bio or links point at the person's LinkedIn | The profile read |
| The account lists an email or phone Orbit has for the person | Business contact details |
| A page of theirs that Orbit's research confirmed links to the handle | The research loop finds these and discards them today |
| The student's address book lists the handle on their card | New work: contact cards are not read for handles today |
| The student said so, for someone they know | The confirm card |

A handle is always turned into the platform's id before it is attached, and checked again on each read, because
handles change hands.

**A score, when there is no hard proof.** Candidates are people whose name could fit. Signals are in two groups.

Signals about this one person. An automatic match needs at least one:

| Signal | Detail |
|---|---|
| Same personal link | Both point at the same personal site. Link hubs count only when the full address matches |
| Same picture | The same image, by a fingerprint of the file. Default avatars and logos are excluded. This is not face recognition |
| Employer and role together | The bio names the employer and something of the title |
| School and year together | "Stanford 25" against Stanford, class of 2025 |
| An exact contact | An email or phone on the account |

Supporting signals. They raise or lower a score and never attach on their own:

| Signal | Why it only supports |
|---|---|
| Name | Many people share one |
| Handle spells the name | A handle is chosen by its owner, so it counts half. A handle with digits (`jason.chen22`) counts for nothing. Orbit treats email addresses this way today |
| Employer alone, or school alone | Two students with the same name at one school share both. Today a shared employer alone never merges either |
| Shared neighbours | The same two students also share friends |
| Place | Coarse |
| Rare name | Raises confidence. From public name-frequency lists bundled with Orbit |
| Against: a public figure with the same name | A namesake |
| Against: the person lists another handle | Lowers the score. Not a hard no, because people keep second accounts |

Two rules on top: if two people could fit one account, Orbit asks and never picks; and an account sorted as a public
figure, brand or unknown is never matched by score.

**Three outcomes.**

| Result | What happens |
|---|---|
| Hard proof, or a very high score with a signal about this one person | Attached |
| Middle, and the student knows the person | A card: "Is @jchen_22 on Instagram the Jason Chen you know from Stripe?" with the evidence both ways. No is remembered |
| Middle, and the student does not know the person | Nothing. Orbit never asks a student to confirm a stranger |
| Low | Left apart |

"Knows" means there is a two-way tie already: messages both ways, a meeting, or a connection.

**Targets.** Because a student cannot confirm a stranger, a target's account is attached only by hard proof, until
automatic matching has been measured on real accounts (8.2). Orbit looks for that proof only for people the student
is going after, from a small daily budget.

**Attach and detach.** Attaching an account is a link. It does not merge two people, because merging in Orbit deletes
one of them and cannot be undone. Every message, touch and tie that came from an account keeps that account's id. So
a wrong match is undone from the person's page with "Not their account":

| Thing | On detach |
|---|---|
| Messages and touches from that account | Move to a person of the account's own |
| Follow ties | Deleted and rebuilt from the graph for the right person |
| A chat that moved to "replied" on a message from that account | Orbit proposes moving it back. The student decides |
| The match | Remembered as "not the same", never proposed again |

When the account already had its own person and the student then says it is someone else in People, the two people
are merged as Orbit merges any two today. Detach still works afterwards, because the rows are stamped.

**New storage.** Attached accounts, proposed matches, and remembered "No" answers each need a table, since the ones
Orbit has are person to person. They are added to what the browser pulls so the handle and the cards reach it.

### 3.5 Where the follow graph is kept

| Table | Holds | Who can use it |
|---|---|---|
| `social_accounts` | One row per account Orbit has a reason to know: public profile fields, kind, when read | Shared across students. Public fields only |
| `social_follows` | "A follows B", as two ids and a date | Rows from a public account's list are shared. Rows from a student's own lists belong to that student |
| `social_list_reads` | For each account and list: how many rows, whether it is complete, who read it, when | Shared for public lists |
| `social_suppressed` | Accounts that must not be stored or used | Checked before every store and every reuse |

**What "complete" means.** A missing row means "does not follow" only if the list is complete. Complete means the
read reached the end and the rows are within a set tolerance of the count on the profile. A list read partly is
marked partial and can find bridges but can never prove there are none.

**Sharing safely.** A list can look different to different readers, so each read records who read it. Before a shared
list answers another student's question, Orbit checks the account is still public, and drops the list if it is not.
Lists are kept 30 days.

**Keeping little.** A list read stores ids only. Orbit fetches a name and profile only for an account that matters:
it is in a student's circle, or it is a bridge.

**Opting out.** A student can stop their own accounts being used to find paths for anyone else. A request from
someone who is not an Orbit user is honoured the same way. Deleting an Orbit account removes the student's rows from
these shared tables as well as their own.

### 3.6 Finding mutuals

A **bridge** is someone the student has a two-way tie with, who also has a two-way tie with the target. On platforms
where following is one-way, direction matters:

| Between the bridge and the target | Meaning | Use |
|---|---|---|
| They follow each other | They likely know each other | A path |
| Only one follows the other | A fan, or someone who is watched | Never a path. It can strengthen another tie between the same two people |

Only "follow each other" makes a path, because an introduction needs the bridge to actually know the target. That is
one rule, and it makes the lookup cheap.

**The lookup, for one student and one target account:**

1. **Is the source on, and is the target's account attached?** If not, stop.
2. **Ask the graph.** Bridges are a single query: accounts in the student's circle that the target follows and that
   follow the target. This runs every time. Orbit does not keep old answers, so a list another student completed
   yesterday, or a friend the student followed this morning, counts at once. If both of the target's lists are
   complete and fresh, this is the whole lookup and costs nothing.
3. **The count (Instagram).** One profile read returns how many accounts the student follows that also follow the
   target. A bridge is one of those by definition. If the count is zero there are no bridges: stop, after one call.
   The same read says whether the account is private. Kept 14 days.
4. **The target's shorter list, to the end.** Now the candidates are the accounts in the student's circle on that
   list. If there are none, stop.
5. **Confirm the other direction for those few candidates,** from whichever side is cheaper: the target's other list
   (stopping when every candidate is settled or the count is reached), or each candidate's own list, which Orbit may
   already hold and which will answer future targets too.
6. **Write the ties** and rerun the query.

A lookup that needs many calls runs as a job that remembers where it stopped, and the student gets a notice when it
finishes. On Instagram's budget that can be minutes or a few hours, depending on list sizes and on a page size the
test in section 13 has to confirm.

**Ties follow the graph.** A follow tie is rewritten from the graph on every lookup and removed when the follow is
gone or the list behind it expires. Today's tie writer only ever raises a weight, so follow ties get their own.

**The free graph.** When the bridge is an Orbit student who connected the same source, Orbit already holds their
lists. Using them to answer another student's question needs that student's yes: a separate switch, off by default
("Let my Orbit friends find paths through who I follow on Instagram"), only between friends. It is separate from the
sharing Orbit has, which shares people and companies and has no way to describe a list of accounts. X data is never
used this way, because X's rules limit passing it on.

### 3.7 How this enters warm paths

Path finding keeps its shape and gains evidence.

- Two kinds per platform: `instagram_mutual` and `x_mutual` can carry a path; `instagram_follow` and `x_follow` are
  one-way, carry a direction, and only support.
- **Evidence about the same two people adds up.** If Maya and the target are connected on LinkedIn and also follow
  each other on Instagram, the engine already combines both into one stronger tie. This is why matching people across
  platforms is the centre of the plan: without it Maya on LinkedIn and Maya on Instagram are two weak bridges, and
  with it she is one strong one.
- **A follow from a selective account weighs more.** A target who follows 150 accounts and follows Maya back very
  likely knows her. One who follows 5,000 may not. The weight starts near a LinkedIn mutual's and shrinks as the
  following count grows. The numbers are set from the labelled data in 8.3.
- **The first step uses closeness,** which now includes the new sources (3.8).
- **The words name the platform.** "Maya and Priya follow each other on Instagram." X's rules require a follow shown
  to a user to be labelled as from X.
- A path that rests on a follow and nothing else is marked a weaker route.

The change is made where signed-in paths are computed (the server) and in the browser for the demo.

### 3.8 Closeness

Closeness is one model. It was fitted on email and LinkedIn, and the review showed that chat apps would distort it if
they were poured in unchanged: a fast "lol" would look like the fastest reply Orbit has ever seen. So chat channels
(Instagram, X, texts) get rules of their own.

| Rule | Detail |
|---|---|
| One touch per day each way | Counted in the student's own time zone. New work on the server, which counts every message today |
| Words count | A day counts when something was written. A day of only reactions or forwarded posts is light engagement |
| No answer, no tie | Messages from someone the student never answered count for nothing and do not make a tie exist. This is a new, explicit rule. Today's cap only covers the opposite case |
| Groups weigh less | A chat with more than one other person counts for a fraction: half up to four people, a quarter up to eight, nothing above. This needs a weight on a message, which the model lacks today |
| Reply speed is not read from chat | The reply-speed signal stays an email and LinkedIn signal. For chat it is left out, not counted as fast |
| Following each other | A new signal, one per platform, beside "connected on LinkedIn". Per platform so each can be fitted, and left out of what a friend sees, on its own |
| Existing scores do not move | A student with no optional source gets exactly the scores they have now. A test holds this |

**How it is checked.** Two ways. First, a set of chat-only relationships with known answers (a best friend, a group
chat acquaintance, a one-sided requester) that the model must order correctly. Second, where a student has told Orbit
how close they are to people, the ordering with a source on may not be worse than with it off.

### 3.9 Personal messages are not networking mail

Reusing the LinkedIn message pipeline as it is would misfire. Today every LinkedIn message is stored in full, sent to
a model to classify, can trigger a drafted reply, and makes the sender someone the student "owes". A friend's DMs
should do none of that.

| | Networking chat (the person is in the student's pipeline) | Any other Instagram or X chat |
|---|---|---|
| What is kept | The words | Only the time, the direction, and whether words were written |
| Classified by a model | When the student is waiting on that person | Never |
| Can it draft a reply | Yes, for the student to approve | Never |
| Counts as "owes a reply" | Yes | No |
| Shown in the Messages tab | Yes | A count and dates only |

When a person enters the pipeline, Orbit reads that one chat's recent history so the conversation is there. Warmth of
a reply is judged by word rules as the message arrives, and only the result is kept. A daily cap limits how many
messages can be sent to a model.

### 3.10 Plumbing that is LinkedIn-only today

Each is widened by adding, never by changing what exists:

| Today | Becomes |
|---|---|
| A connected account is `google`, `linkedin` or `village` | Also `instagram`, `x`, `imessage` |
| A message comes from `gmail` or `linkedin` | Also `instagram`, `x` |
| An identity is an email, LinkedIn id or phone | Also an account id per platform |
| The connect link asks Unipile for LinkedIn | Takes the provider |
| The Unipile webhook looks up a LinkedIn account | Looks up whichever account the event names |
| Budgets are per day, reset at midnight UTC | Instagram needs rolling one-hour and 24-hour windows |
| Budget shares are "fill up to this much" | Kept. Background work fills to 60 percent at most, so the student's own request always has room |
| The shared store and call counts are LinkedIn tables | New tables with a source column. The LinkedIn ones stay |
| A draft goes by Gmail or LinkedIn | Also Instagram, X, or "open in Messages" |
| Readiness tracks LinkedIn and email | Shows a step per optional source. Optional sources never hold up "ready" |
| Account deletion sweeps tables that name the user | Also the shared graph tables |

## 4. Instagram, complete

**Connect.** The student turns Instagram on, sees what Orbit will read and the risk note (section 9), and signs in on
Unipile's page with their Instagram username and password, plus a code for two-step sign in. Sign in with Facebook is
not supported.

**First days, inside the budget.** Unipile advises about 100 actions a day and 10 an hour, at uneven intervals.
Whether plain reads count the same as follows and messages is something the test has to show; the plan assumes they
do.

| Order | What | When it is ready |
|---|---|---|
| 1 | The student's own profile, and their chats | The first hour. Closeness from DMs starts here |
| 2 | Who the student follows | Minutes if the list comes in large pages, a day or two if it comes 25 at a time |
| 3 | Who follows the student, 25 at a time | Over the following days. Until then, a two-way DM history proves a two-way tie |

**Ongoing.** New messages arrive by webhook at no cost in calls. The student's lists are refreshed a page at a time
at uneven hours, because Unipile warns that fixed schedules get accounts flagged.

**People.** Chat partners and accounts the student follows back go through 3.3 and 3.4.

**Mutuals and paths.** As 3.6. Followers come 25 a page. A verified target returns only a sample of followers, so a
verified target's follower list is never complete and Orbit confirms from the candidates' side.

**Sending.** Instagram becomes a way to send a draft. Never by itself: every message needs the student's tap, the
rule LinkedIn has. A cap of 10 a day. A message to someone who does not follow the student lands in their requests,
and the draft box says so first. Not connected: "Open in Instagram" opens the chat and copies the draft, and Orbit
waits for the student to say it was sent.

**Replies.** A message on a chat where the student is waiting moves it to "replied".

**When it breaks.** Instagram sometimes asks the student to confirm it is them. The row shows "Sign in again", the
student is told once, and the rest of Orbit carries on. After a new sign in, messages are matched by Instagram's own
ids from a floor date, so nothing doubles.

## 5. X, complete

**Connect.** The student signs in with X in the browser. Before that, a screen says what Orbit stores, because X
requires consent to store DMs beyond the sign in itself. Orbit needs its own X developer app and prepaid credits.

**What it costs, worked through.** Everything read is $0.01 per person or message.

| Moment | What is read | Cost |
|---|---|---|
| Connecting | Who the student follows (about 400), 30 days of DMs (capped at 100) | About 5 dollars, once |
| Any month the student uses X paths | Their follow list again if it is over 30 days old | About 4 dollars |
| Each new target | The target's follow list, only if it is under a size limit (600 to start), read to the end or not at all | 2 to 6 dollars |
| Confirming a bridge | The bridge's own list, under the same limit, when Orbit does not hold it | 0 to 6 dollars |
| A target another student already checked this month | Nothing | Free |

So X is on request only. "Check X for Priya" shows the price before anything is read. A monthly limit per student (15
dollars to start) and a limit for all of Orbit stop spending at once when reached. Credits are prepaid, which caps
the worst case at what was loaded.

**Why "to the end or not at all".** A partial list can never prove there is no bridge and can never be reused for the
next student. Paying for half a list buys almost nothing.

**Keeping current, cheaply.** X requires stored data to follow the platform. Orbit does that by letting X data expire
after 30 days and deleting it, and reading again only when a student asks. It does not pay to refresh data no one is
using.

**Mutuals.** As 3.6, without the count. If X reports each account's relation to the signed-in student, as its
documentation suggests, the follow-back list never needs reading. Protected accounts are never read.

**Matching people.** As 3.4, with X's rule on top: an X account may be tied to a real identity only from public
information, from what that person gave, or with their consent. Public links fit. A student's own say-so and an
address-book entry are neither. Until a lawyer has read the policy, X accounts are attached by public proof only.

**Closeness.** Thirty days of DMs is all X gives, so X adds little at first. Students waiting on a reply over X are
checked hourly; everyone else daily.

**Sending.** With the student's tap. Orbit checks first whether the person accepts DMs from the student.

**A limit to know.** X describes pay per use as for early products with limited users. It fits Orbit now. At a few
thousand connected students it means a contract.

## 6. Texts (iMessage), complete

**What exists.** The engine that reads a Messages file, names people from the student's contacts, counts a touch per
day each way and proposes "replied" is written and tested. No screen calls it. I said earlier that students already
had this; they do not.

| Piece | Detail |
|---|---|
| The screen | A Texts row in Settings and an optional onboarding step, on Macs only. Guided: pick the Messages file, pick an exported contacts file |
| The newest messages | Messages keeps the last few days in a side file. Today's reader takes one file, so those days are missed. Reading both is new work, and may mean the student picks the folder |
| Update | The student picks the file again. Chrome and Edge may be able to remember the folder so it is one click; the test has to show it |
| Days | Counted in the student's time zone. Today they are counted in UTC, which splits an evening in two |
| Group chats | Read for groups up to eight, at the fraction in 3.8 |
| Handles from contacts | A card that lists an Instagram or X handle is hard proof for a person the student knows |
| Signed-in students | Decision 1 below |
| Sending | "Open in Messages" opens the conversation with the draft written. Orbit waits for the student to confirm it went, then looks for the answer on the next update |
| A second device | The words stay in the browser that read them. Another device shows counts and dates |

**What texts do for paths.** No bridges. They make the first step honest: a bridge the student texts weekly ranks
above one they connected with once. They also give phone numbers, which are exact keys for matching.

**Not on a Mac.** The row is hidden. A live link that reads and sends from the student's number needs software on the
Mac and is outside this plan.

## 7. Every place this touches

Each source goes through this list before it counts as finished:

- [ ] Settings row, switch, the four states, remove, a different account
- [ ] Onboarding step, optional
- [ ] Chat: setup card, tools, the capability list, what the model is told is connected
- [ ] Readiness steps, and the notices: "finished checking Instagram for Priya", "sign in again"
- [ ] People: matching, the confirm card in the morning brief, the handle on the person page, "Not their account"
- [ ] Messages tab and the last messages on a person's page, by the rules in 3.9
- [ ] Closeness on the server, and in the browser for texts and the demo
- [ ] Mutuals: lookup, the "People who know" list
- [ ] Paths: the words, the weaker-route mark
- [ ] Discover and sourcing: the "intro possible" tier can name a bridge from the source
- [ ] Drafts: the channel, the tap-to-send rule, caps, the fallback link, the touch written on send
- [ ] Replies and stage moves
- [ ] Friends: the follow-list switch, what is left out of the score a friend sees
- [ ] Budgets, call counts, the cost view
- [ ] Parking, signing in again, account deletion, the opt-out list
- [ ] Privacy screen and policy
- [ ] Demo data and the fake account

## 8. Testing

### 8.1 Switches

- The removal test (3.2): 8 combinations, on two kinds of student, at every entry point.
- Each source through its four states, one at a time. Your switch, one source at a time.
- No request goes to a source that is off.
- A student with no optional source has exactly today's scores and paths.

### 8.2 The matching engine

| Test | What it proves | Bar |
|---|---|---|
| A labelled set of account and person pairs, built like the set Orbit has for people | The rules decide right | No wrong automatic match. At least 150 pairs, more than 60 that are the same person and more than 60 that are not |
| Traps in the set | The known ways to be wrong | A namesake at the same school, a namesake at another school, a celebrity namesake, a second private account, a handle with no name, a name in another script, a nickname handle, a photographer's business page, a parody, the same picture on a default avatar |
| The kind sorter | Brands and public figures never become bridges | None sorted as a person |
| Real accounts, labelled by hand, kept out of the repository | It holds on real data | Before automatic matching by score is switched on: at least 98 of 100 automatic matches right, on 200 or more pairs from at least three students, not only your own account |
| Detach | A wrong match can be undone | After detach, closeness and paths equal a student who never had the match |
| In production | It stays right | The share of "No" on confirm cards, and the share of detaches |

Hard proof attaches from the first day. Matching by score starts as "ask the student" only.

### 8.3 Mutuals and paths

- A fake platform with a known graph: every bridge found and none invented, for complete and partial lists.
- "No one" is never reported from a partial list.
- The order: a held list makes no call, a zero count makes one.
- A second student asking about the same target makes no call. A list from an account that has turned private is
  dropped, not reused.
- A student's own lists never answer another student unless both switches are on. X lists never do.
- A bridge on two platforms outranks the same bridge on one. A one-way follow never makes a path.
- Unfollowing removes the tie on the next lookup.

### 8.4 Closeness

The rules in 3.8, each with a case; the chat-only set; the comparison with students' own answers.

### 8.5 Personal messages

A friend's DM stores no words, calls no model, drafts nothing and creates no "owes". Adding that friend to the
pipeline brings in that one chat.

### 8.6 Budgets and failure

- Instagram's rolling limits hold, and background work never leaves the student's own request without room.
- X spending stops at both limits, and the price shown before a check is at least what is charged.
- Each source failing leaves the others working.

### 8.7 End to end

The demo gets a fake Instagram, X and Texts. Tests connect each, find a path through each, send through each, switch
each off, detach a wrong match, at phone and desktop sizes.

## 9. Privacy, rules and risk

| Risk | What the plan does |
|---|---|
| Instagram does not allow automation. An account can be warned or restricted | Said plainly before connecting. Orbit reads far more than it writes, stays under Unipile's limits, spaces calls unevenly, and never sends without a tap |
| Friends' private messages on Orbit's server | Words are kept only for chats with people in the student's pipeline. For everyone else, only when and which way (3.9) |
| Follow lists of people who never signed up | Ids only. Profiles only for accounts that matter. 30 days. An opt-out list. Private accounts never shared |
| A wrong match invents a path | 3.4 and 8.2, and "Not their account" undoes it |
| X's rules on matching, storing DMs, labelling follows, keeping data current, passing data on | Section 5 and 3.6. A lawyer should read X's policy before X goes live |
| One student's network reaching another | Own lists are private. A separate switch, off by default, friends only. Never for X. Texts and X are left out of the score a friend sees |
| Texts are the most private thing Orbit touches | The words never leave the browser |
| A student wants out | Off stops reading at once. Remove deletes what was taken, including their rows in the shared graph |

The privacy screen and policy are rewritten to name each source, what is read, what is shared and for how long. One
thing found on the way: the policy says shared public reads are kept up to 1 day, and the code keeps them 30. That is
wrong today and is corrected with this work.

## 10. Cost

| Source | Per student | What drives it | The lever |
|---|---|---|---|
| Instagram | 3 to 5 euros a month while connected | The Unipile seat | Release idle accounts after 21 days |
| X | About 5 dollars once, then 4 dollars in a month it is used, plus 2 to 10 per new target | People read | On request only, shared lists, both limits |
| Texts | Nothing | | |
| Model calls for messages | Small and capped | Only pipeline chats are classified | The daily cap |

Unipile's seat prices come from third-party write-ups and should be confirmed with Unipile. The X figures are worked
from X's published per-read price and my guesses at list sizes.

## 11. Build order

| Stage | What | Size | Ends with |
|---|---|---|---|
| 0 | The tests in section 13, including the target hit rate | Small | The unknowns answered, and a yes or no on the Instagram graph |
| 1 | The base: optional sources and switches, the off rule and removal test, accounts and identity kinds, attach and detach, the widened plumbing, the personal lane | Large | Nothing new visible. Today's behaviour unchanged, proven by tests |
| 2 | Texts: the screen, the newest messages, time zones, groups, signed-in students | Medium | Texts count in closeness for everyone on a Mac |
| 3 | Instagram messages and people: connect, webhook, closeness, matching by hard proof and by asking | Large | Instagram counts in closeness |
| 4 | Instagram graph: own lists, the lookup, the shared graph, paths. Only if stage 0 says the hit rate is worth it | Large | Paths through Instagram |
| 5 | Instagram sending and replies | Medium | Instagram complete |
| 6 | X, if still wanted | Large | X complete |
| 7 | The friends' follow-list switch, cost view, policy, automatic matching once measured | Medium | Section 7 ticked for every source built |

Texts first: the engine exists and it costs nothing to run. Stages 2 and 3 can run side by side once stage 1 is in.

## 12. Decisions for you

I will go with the recommendation on each unless you say otherwise.

1. **Texts for signed-in students.** For closeness to count on the server, the browser has to send, per person, how
   many texts each way per day. For a friend who exists only in texts it also has to send their name and number, or
   that friend cannot be a first step for a signed-in student. The words are never sent. Recommended: yes to both,
   said plainly on the Texts screen. The alternative is that texts only count in the browser that read them.
2. **Words of Instagram and X messages.** Keep them only for people in the student's pipeline. Recommended.
3. **Friends' follow lists.** A separate switch, off by default, friends only, never X. Recommended.
4. **Instagram's risk.** Go ahead with a plain warning, reading first, sending by tap only. Recommended.
5. **X.** Build last, on request only with the price shown, 15 dollars a student a month to start, after a lawyer
   reads the policy. It costs money, so I will ask again before anything is bought or switched on.
6. **Pictures.** Same image only, never face recognition. Recommended.

## 13. What a short test has to confirm first

**The one that decides the most: target hit rate.** Take 50 real people from a real pipeline and count how many have
hard proof of an Instagram account: on their LinkedIn, by a link back, or from research. This says whether the
Instagram graph (stage 4) is worth building. LinkedIn only returns contact details for first connections, so the
honest expectation is that this number is low for strangers.

**Instagram, on your own account through Unipile**

- How many accounts one call to the following list returns.
- Whether a target's follower list comes back with the accounts the student follows first.
- That the count on a profile means what section 3.6 takes it to mean.
- Whether reads count toward the 100 a day and 10 an hour, or only follows and messages do.
- How far back chat history goes, whether requests appear, how groups come back.
- Whether there is a search by name.
- How often Instagram asks the account to confirm itself.

**X, with a developer app and a few dollars of credit**

- That each account in a list reports its relation to the signed-in student.
- Whether a protected account's lists can be read at all.
- Real list sizes for a sample of targets, to set the size limit and the prices shown.

**Texts, on a Mac.** This one can change the design of the Texts screen.

- Whether the browser can open the Messages folder, or the student has to copy the file out first.
- That the side file with the newest messages can be read in the browser.
- Whether Chrome can remember the folder for a one-click update.

## 14. What changed from the first version

| The first version said | The review found | Now |
|---|---|---|
| Most follows stay accounts, and accounts can be bridges | Paths only work between people | A bridge becomes a person when it is found (3.3) |
| A one-way follow from the target could carry a path | The count, the lists and the tests disagreed about direction | Only following each other carries a path (3.6) |
| One function filters, one rescore on a switch | Scores are stored and read in a dozen places | A checklist of read sites, a switch job, and a stricter removal test (3.2) |
| LinkedIn and Gmail get the same switch for free | Their rows carry no source, and most people exist only because of LinkedIn | Switches cover the three new sources only |
| A wrong match can be undone | Merging deletes a person and cannot be undone | Attaching is a link, rows are stamped, detach is designed (3.4) |
| A confirm card finds a target's handle | The student does not know the target | Targets by hard proof only, and the hit rate is measured first (2, 3.4, 13) |
| Employer, school or shared friends can prove a match | Two same-name students at one school share all three | A signal about the one person is required (3.4) |
| DMs go through the LinkedIn message pipeline | It stores every word, calls a model per message and can draft replies | A personal lane (3.9) |
| Chat counts like email | Fast chat replies would look like the strongest ties Orbit has | Chat rules (3.8) |
| Texts send only counts to the server | Text-only friends would not exist there | Decision 1 says what is sent |
| X at 5 dollars a month | Connecting alone costs that | Worked costs, on request only (5) |
| Instagram usable within the hour | Ten calls an hour | Honest timings and a job with a notice (4) |
| An answer is kept 14 days | It would hide newer data | The graph is asked every time (3.6) |
