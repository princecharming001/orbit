# 39. Chat context: what a message is read with

The student's complaint: "my most recent message should have context of what I said earlier in the chat", and the
chat should also know what was said in other chats, what the student sent out, and what came back.

This plan records what the chat did before, what the research says, what was measured, and what was built.

## 1. What the chat did before (audit, checked against the code)

| Layer | Before |
|---|---|
| Earlier turns of this chat, with Claude | Replayed in full on every turn, tool calls and results included (`store.history`). Summarised only by server-side compaction. |
| Earlier turns, no-Claude fallback | The last 8 cards and the one message before this one, read only for a person's name (`routerThread.ts`). |
| Other chats | Never read again. Opening Orbit starts a new chat; the old one sits under Recent. |
| Memory | Facts the student stated, learned after a turn; matched against the current message only, so a short follow-up recalls nothing. |
| Sent messages and replies | Not in the per-turn context. Only reachable if the model decides to call a tool. |
| Tests | None for recall across chats. |

Usage records for the owner's account show chats run through Claude, not the fallback, so the first row is the one
that applies in practice.

## 2. What the research says

Sources are in the session notes; the points that shaped the design:

- **Raw history plus good search is a strong baseline at this scale.** On LoCoMo a plain full-context baseline beat
  Mem0 (72.9 against 66.9 in Mem0's own paper), and a file-search agent scored 74. Summaries are the worst retrieval
  unit (LongMemEval, LoCoMo), so summarise only what is evicted and keep the raw turns searchable.
- **A small always-present record plus search on demand** is how the consumer products do it: ChatGPT injects saved
  facts and digests of recent chats (the student's own messages only); Claude adds a visible chat-search tool.
- **Context is a budget.** More tokens lower recall ("context rot"), so each block is capped and holds names and ids,
  not bodies. Anthropic's guidance: a small up-front context, then just-in-time retrieval through tools.
- **Stored text is an injection path.** Memories and inbound mail are attacker-reachable (SpAIware, MINJA). Only the
  student's own words and Orbit's own summaries go into the standing context; what someone else wrote stays behind
  tools that wrap it as untrusted.
- **Keep the cache prefix stable.** Volatile context goes after the cached block and is appended only when it changes.
- **Measure with scripted multi-turn cases** drawn from real failures, run on a fixed fixture, with should-recall and
  should-not-recall cases.

Not adopted, and why: a knowledge graph (Zep) needs a graph database and heavy model ingestion; embeddings add a 23 MB
model for a gain that is unproven at one student's scale. Lexical search (MiniSearch, already a dependency) is the
measured starting point; embeddings are the next step only if recall proves poor.

## 3. What was measured first

Nine scripted conversations on the demo account against the real model (`e2e/gallery.spec.ts`, group "Context"):

| Case | Before |
|---|---|
| Pronouns, "the second one", "why them", "who else there", "go back to the Ramp people", "actually I meant Hannah" | Worked. |
| "what did I send out most recently and has anyone replied" | Failed: "I don't see anything sent through Orbit yet". |
| New chat, then "what were we just talking about in my last chat" | Failed: "I can't see your past chats". |
| New chat, then "pick that back up" | Failed: "Memory has nothing from that chat". |

So with Claude on, one chat holds its own thread. What was missing is everything outside the chat in hand.

## 4. What was built

All in `apps/web/src/chat/agent/chatContext.ts` unless noted.

1. **Earlier chats, in every turn's context.** A record of the last four conversations: when, the student's first and
   latest ask, and the last thing Orbit did, each with the conversation id. At most 900 characters. Temporary chats,
   Orbit's own notes and decision lines are never read as the student's words.
2. **`search_chats` tool.** Lexical search (MiniSearch, prefix and fuzzy) over every past conversation, the student's
   words ranked above Orbit's and recent chats above old ones. An empty query returns the latest chats in order.
   Loaded up front, so "last time" never waits on a tool search.
3. **Recent messages, in every turn's context.** Who the student wrote to in the last 14 days and who wrote back, by
   name, id, channel and day, with "replied / no reply yet" and "answered / not answered yet". No message text.
   Counts what went out through Orbit too, for an account whose mail is not kept in the browser.
4. **Memory recalled by the thread, not one line.** A follow-up under 40 characters recalls with the student's last
   two messages as well (`loop.ts`, `snapshot.ts`).
5. **Compaction keeps more.** The instructions now also keep each ask and its outcome, companies and what was found,
   each list of people with ids in order, what the student said about themselves, and corrections (`loop.ts`).
6. **The prompt says how to read with context** (`system.ts`, version 29): a short follow-up continues the thread;
   answer "last time" from the record or `search_chats`; never say earlier chats cannot be seen.
7. **The fallback understands it too** (`routerNetwork.ts`): "what were we talking about", "pick up where we left
   off", "find that list you gave me last week" route to `search_chats`.

Budget: the snapshot stays under 1,250 estimated tokens (was 800); the fixed prompt under 25,000 characters.

## 5. Tests

- `chat/__tests__/chat-context.test.ts`: the record, its budget, what it never includes, search ranking, the tool,
  recent messages without anyone's words, and the snapshot carrying both.
- `chat/__tests__/router-network.test.ts`: the fallback routes.
- `e2e/gallery.spec.ts`, group "Context": thirteen scripted conversations, including `new:` to start a fresh chat
  mid-case. Run through the local CLI shim, never the API key, never in CI.

## 6. Not done yet

- The fallback still has no company focus ("who else there") and cannot answer a question Orbit asked in words.
- A fallback turn stores only its summary text, so a later Claude turn in that chat does not see the card's ids.
- Sent and received mail is searchable by content only through `list_inbox` (live Gmail) and `get_person`.
- Embedding search, if lexical recall over past chats proves too weak.
