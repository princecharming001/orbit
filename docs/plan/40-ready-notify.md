# 40. Is Orbit ready yet

The problem: while Orbit reads LinkedIn and Gmail for the first time, a new student cannot tell where it is, whether it
is still working, or when it is ready to use. That makes the first try confusing.

## What other apps do

- **Monarch** shows a short checklist that ticks off as each source finishes ("Syncing transactions", "Updating net
  worth").
- **Contractbook** keeps "Importing… (33%)" in the top bar and a banner on every page while it runs.
- **HubSpot** and **Clay** say "we'll email you when your import is finished" and do.
- **Quo** and **Revolut** put the flag and the dial code inside the phone field, with a searchable country list.

## One answer for "ready"

`packages/core/src/sync/readiness.ts` turns the import's own state into steps, each waiting, working (with a count),
done, or needing the student:

| Step | Done when |
|---|---|
| LinkedIn connections | the first pass has moved past reading relations |
| LinkedIn messages | the first pass finished (`syncedAt`) |
| Recent email | Gmail's import moved past its last-90-days phase |
| Older email | Gmail's import is `complete` |
| Mapping your network | no jobs left in the queues for the student |

A step exists only for what was connected. The whole is `syncing`, `usable` (the people and the recent mail are in),
`ready` (every step done), `problem` (a source needs signing in again) or `nothing` (nothing connected). The app, the
server and the email all use this one function.

## In the app

- **Sidebar chip** (`components/sync/ReadinessChip.tsx`): "Syncing · 62%", "Finishing · 85%", "Ready" or "Needs you".
  It opens the checklist, which also says how the student will hear it is done.
- **Chat line**: while it runs, a slim line at the top of the chat ("Reading your LinkedIn. Answers get sharper as it
  comes in · 41%") that opens the same checklist in place. It goes away once ready.
- **The moment it finishes** in front of the student, one toast: "Orbit is ready", with a link to who to reach out to.
- **Last setup screen**: the live checklist in place of a static "You're all set".
- **The chat** knows where setup stands (a line in its per-turn context). While it runs, with no phone on file and
  texting set up, it may ask once for a number; one given goes to `save_phone`.

`state/readiness.ts` asks the server every 6 seconds while anything is still coming in and the tab is visible, every
5 minutes once ready. When the new function does not answer, it falls back to the `/sync/status` the app already polls.

## Phone number

A country-code phone field (`components/PhoneField.tsx`): flag and dial code inside the field, a searchable country list,
formatting as you type with libphonenumber-js, the country guessed from the student's time zone (+1 for the US). It
appears as an optional setup step after LinkedIn, in Settings, Profile, and through the chat. Numbers are kept as E.164.

## On the server

A new function, `orbit-notify`, separate so the API and the worker are not redeployed for it:

- `POST /notify/status` (signed in): the readiness, the student's contact row, and whether email and texting are set up.
- `POST /notify/contact` (signed in): a phone number (E.164) and which ways to be told.
- `POST /notify/sweep` (pg_cron, every 2 minutes, only while someone who signed up in the last 7 days has not been
  told): when a student's import is `ready`, "Orbit is ready" goes out once by email (Resend) and by text (Twilio, when
  they gave a number). Readiness reached more than 12 hours earlier is noted without a message. A provider failure is
  tried again on the next sweep; nothing set up to send with is noted as told.

`orbit.user_notify` (migration `20261128_orbit_user_notify.sql`, additive) keeps the number, the choices, when readiness
was reached and when the message went out.

## What has to be set up to send

- **Email:** `RESEND_API_KEY` in `orbit_private.secrets` (or a function secret), and the sender's domain verified in
  Resend. Without `RESEND_FROM` the sender is `Orbit <orbit@tryorbit.today>`.
- **Texts:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` (a number, or a Messaging Service id starting
  `MG`). Until they are saved, the app does not offer texts and no number is texted.

All are read on each send, so a value saved later works without a redeploy.

## A note from a person

The email is a short note someone typed, not a product email: plain text only, no template, no button, no logo. Three
more values say who it is from, kept with the keys:

| Value | What it does |
|---|---|
| `RESEND_FROM` | The sender line, such as `Sam Rivera <sam@tryorbit.today>`. |
| `NOTIFY_SIGN_NAME` | The first name the note is written and signed in ("Sam here. I'm building Orbit…"). Without it the note is signed "Orbit". |
| `RESEND_REPLY_TO` | The inbox a reply goes to. Only when it is set does the note say "just reply to this email". |

`tryorbit.today` receives no mail, so without `RESEND_REPLY_TO` a reply would bounce and the note never invites one.
The text follows the same rule: with a name it opens "Hey Ana, it's Sam from Orbit."
