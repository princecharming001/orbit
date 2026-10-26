# 25 · One inbox: every conversation, read live, inside Orbit

Status: built (2026-10-25). Owner: Orbit. Scope: local (browser) mode, where LinkedIn and Gmail are read live in the
student's browser. Account mode keeps its server reader; the same message shape lets it adopt this later.

## Why

A Drafts card said "Nishita replied. Orbit cannot see what they wrote". Orbit had read the reply: the LinkedIn reply
reader (engine/linkedinInbox.ts) runs every few minutes, reads the message text and moves the chat to Replied. It
then threw the text away. The card rules read the last reply only from the chat's one email thread
(engine/brief.ts `lastInboundByChat`), saw a Replied chat with no reply in it, and fell back to "cannot see". The DM
history reader (engine/linkedinActivity.ts) also kept only touches. So the student had to open LinkedIn to read the
reply, answer it, and come back.

The aim (the founder's words): students should not have to go to other platforms; they coordinate and understand
everything from Orbit.

## What changes

1. **LinkedIn messages are messages.** Every 1:1 LinkedIn message with someone Orbit has (matched by member id only,
   the plan 17 rule) is kept as a message row on a thread of its own: `channel: 'linkedin'` on both, the thread keyed
   `linkedin:<chat id>`, each message `linkedin:<message id>`, written idempotently by both LinkedIn readers (the reply
   reader and the history reader). Inbound messages are read like email (core `heuristicSignal`: the signal, times
   offered, what they asked). LinkedIn threads are never set as a chat's `threadId`: that field drives Gmail
   threading (In-Reply-To), so LinkedIn conversations are found by person instead.
2. **Rules see every channel.** A chat's last reply is the newest of its email thread's replies and the person's
   LinkedIn replies. A LinkedIn reply therefore makes the same cards an email reply does ("Nishita asked about…",
   "is waiting on times"), carrying `inReplyTo` and `channel: 'linkedin'`, and the draft answers what they wrote,
   on LinkedIn. The "cannot see what they wrote" card is left only for a chat the student moved by hand with nothing
   readable, and says so.
3. **Cards show what was said.** A card about a reply quotes it, with where and when ("On LinkedIn, 2 hours ago").
4. **A Conversation tab on every person.** Every message with them, oldest first: Gmail threads, LinkedIn chats and
   the recent iMessage texts Orbit has, each marked by channel. A reply box at the bottom sends on the channel picked
   (LinkedIn or Gmail, the ones Orbit can send on) through the usual draft-and-approve path, and "Check for new
   messages" reads Gmail and LinkedIn right away. Reply notifications open this tab.
5. **The chat can read conversations.** "What did Nishita say?" is answered from the stored messages, every channel,
   wrapped as untrusted text like other message bodies.
6. **The demo shows it.** The sample student has a LinkedIn reply with text, so the flow can be seen and tested.

## Privacy

LinkedIn messages are kept in this browser only (IndexedDB), like Gmail bodies; only for people the student already
has in Orbit; erased with the rest of Orbit's data in this browser; nothing new goes to a server.

## Tests

Storing (idempotent, member id only, reading), rules (a LinkedIn reply makes a reply card, not the fallback), the
draft's channel, the Conversation tab, the chat tool, and an e2e on the demo.
