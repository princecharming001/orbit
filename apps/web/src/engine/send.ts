import type { OutboundMessage, Suggestion, User } from '@orbit/core';
import { linkedinMessageUrl, sha256Hex } from '@orbit/core';
import { addTouchpoint, audit, feedback, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { gmailSend } from '../integrations/google';
import { evaluateImmediateSuggestions } from './brief';
import { evaluateTrigger } from './stages';

export async function checkSendAllowed(
  userId: string,
  personId: string,
  channel: OutboundMessage['channel'],
  kind: OutboundMessage['kind'],
  now = new Date(),
): Promise<{ allowed: boolean; reason?: string }> {
  const settings = await db.settings.get(userId);
  const person = await db.people.get(personId);
  if (!person || person.hiddenAt) return { allowed: false, reason: 'This person is hidden.' };
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const sentToday = await db.outbound
    .where('userId')
    .equals(userId)
    .filter(
      (o) => o.status === 'sent' && o.channel === channel && !!o.sentAt && new Date(o.sentAt) >= dayStart,
    )
    .count();
  const cap =
    channel === 'linkedin' ? (settings?.dailySendCapLinkedin ?? 10) : (settings?.dailySendCapGmail ?? 15);
  if (sentToday >= cap)
    return {
      allowed: false,
      reason: `Daily limit reached (${cap} ${channel} messages). Try again tomorrow.`,
    };
  const cooldown = (settings?.perPersonCooldownHours ?? 72) * 3_600_000;
  const lastToPerson = await db.outbound
    .where('personId')
    .equals(personId)
    .filter((o) => o.status === 'sent' && !!o.sentAt)
    .toArray();
  const last = lastToPerson.sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0];
  if (last?.sentAt && now.getTime() - new Date(last.sentAt).getTime() < cooldown) {
    const chat = await db.chats
      .where('personId')
      .equals(personId)
      .filter((c) => !['archived'].includes(c.stage))
      .first();
    const repliedSince = chat?.lastInboundAt && new Date(chat.lastInboundAt) > new Date(last.sentAt);
    if (!repliedSince && kind !== 'reply')
      return {
        allowed: false,
        reason: `You wrote to ${person.firstName} ${Math.round((now.getTime() - new Date(last.sentAt).getTime()) / 3_600_000)} hours ago and they haven't replied yet.`,
      };
  }
  const chat = await db.chats
    .where('personId')
    .equals(personId)
    .filter((c) => c.stage === 'declined')
    .first();
  if (chat && kind !== 'reply')
    return {
      allowed: false,
      reason: `${person.firstName} declined earlier. Move the chat out of Declined first if that changed.`,
    };
  if (kind === 'bump') {
    const active = await db.chats
      .where('personId')
      .equals(personId)
      .filter((c) => c.stage === 'outreach_sent')
      .first();
    if (active && active.bumpCount >= (settings?.maxBumps ?? 2))
      return { allowed: false, reason: 'Maximum follow-ups already sent.' };
  }
  return { allowed: true };
}

/** Bind approval to the exact text, then send (or hand off to LinkedIn). */
export async function approveAndSend(
  user: User,
  messageId: string,
  bodyFinal: string,
  subject?: string,
  now = new Date(),
): Promise<{ ok: true; handoffUrl?: string } | { ok: false; error: string }> {
  const msg = await db.outbound.get(messageId);
  if (!msg || msg.userId !== user.id) return { ok: false, error: 'Message not found' };
  if (!['draft', 'failed', 'cancelled'].includes(msg.status))
    return { ok: false, error: `Message is ${msg.status}` };
  const hash = await sha256Hex(bodyFinal);
  const edited = bodyFinal.trim() !== msg.bodyDraft.trim();
  await db.outbound.update(messageId, {
    bodyFinal,
    bodyFinalHash: hash,
    subject: subject ?? msg.subject,
    status: 'approved',
    approvedAt: now.toISOString(),
  });
  if (msg.suggestionId) {
    await db.suggestions.update(msg.suggestionId, {
      status: edited ? 'edited' : 'approved',
      decidedAt: now.toISOString(),
    });
    await feedback(user.id, edited ? 'edit' : 'approve', {
      suggestionId: msg.suggestionId,
      outboundMessageId: messageId,
      editDistance: edited ? Math.abs(bodyFinal.length - msg.bodyDraft.length) : 0,
      editBefore: edited ? msg.bodyDraft : undefined,
      editAfter: edited ? bodyFinal : undefined,
    } as never);
  }
  const allowed = await checkSendAllowed(user.id, msg.personId, msg.channel, msg.kind, now);
  if (!allowed.allowed) {
    await db.outbound.update(messageId, { status: 'failed', error: allowed.reason });
    await notify(user.id, 'system', 'Not sent', allowed.reason);
    return { ok: false, error: allowed.reason ?? 'Not allowed' };
  }
  // integrity: re-read and compare hash at send time
  const fresh = (await db.outbound.get(messageId))!;
  if (fresh.bodyFinalHash !== (await sha256Hex(fresh.bodyFinal ?? ''))) {
    await db.outbound.update(messageId, { status: 'failed', error: 'hash_mismatch' });
    return { ok: false, error: 'Approval did not match the text. Nothing was sent.' };
  }
  await db.outbound.update(messageId, { status: 'sending', queuedAt: now.toISOString() });
  let providerMessageId: string | undefined;
  let handoffUrl: string | undefined;
  try {
    if (msg.channel === 'gmail') {
      if (!msg.toEmail) throw new Error('No email address for this person');
      const google = await db.integrations
        .where('userId')
        .equals(user.id)
        .filter((i) => i.provider === 'google' && i.status === 'active')
        .first();
      if (google) {
        const r = await gmailSend({
          to: msg.toEmail,
          subject: fresh.subject ?? 'Hello',
          body: bodyFinal,
          fromEmail: user.email,
          fromName: user.fullName,
          threadId: msg.externalThreadId,
          inReplyTo: msg.inReplyToMessageId,
          references: msg.inReplyToMessageId,
          orbitId: msg.id,
        });
        providerMessageId = r.id;
      } else {
        // Demo / no Gmail: hand off to the mail client
        handoffUrl = `mailto:${encodeURIComponent(msg.toEmail)}?subject=${encodeURIComponent(fresh.subject ?? '')}&body=${encodeURIComponent(bodyFinal)}`;
      }
    } else {
      const person = await db.people.get(msg.personId);
      handoffUrl = person?.linkedinSlug ? linkedinMessageUrl(person.linkedinSlug) : person?.linkedinUrl;
      try {
        await navigator.clipboard.writeText(bodyFinal);
      } catch {}
    }
  } catch (e) {
    await db.outbound.update(messageId, { status: 'failed', error: String((e as Error).message ?? e) });
    return { ok: false, error: String((e as Error).message ?? e) };
  }
  await db.outbound.update(messageId, { status: 'sent', sentAt: now.toISOString(), providerMessageId });
  await audit(user.id, 'message.sent', {
    objectTable: 'outbound',
    objectId: messageId,
    metadata: { channel: msg.channel, kind: msg.kind, hash },
  });
  if (msg.suggestionId) await db.suggestions.update(msg.suggestionId, { status: 'sent' });
  await addTouchpoint({
    userId: user.id,
    personId: msg.personId,
    kind: msg.channel === 'linkedin' ? 'linkedin_out' : 'email_out',
    occurredAt: now.toISOString(),
    refTable: 'outbound',
    refId: msg.id,
    summary: `${msg.channel === 'linkedin' ? 'LinkedIn message' : 'Email'}: ${fresh.subject ?? msg.kind.replace('_', ' ')}`,
    weight: msg.channel === 'linkedin' ? 0.5 : 0.6,
  });
  const chat = msg.chatId
    ? await db.chats.get(msg.chatId)
    : await db.chats
        .where('personId')
        .equals(msg.personId)
        .filter((c) => !['archived'].includes(c.stage))
        .first();
  if (chat) {
    const changes: Partial<typeof chat> = {
      lastOutboundAt: now.toISOString(),
      updatedAt: now.toISOString(),
      outreachChannel: chat.outreachChannel ?? msg.channel,
    };
    if (msg.kind === 'outreach') changes.firstOutreachAt = chat.firstOutreachAt ?? now.toISOString();
    if (msg.kind === 'bump') changes.bumpCount = chat.bumpCount + 1;
    await db.chats.update(chat.id, changes);
    Object.assign(chat, changes);
    const kind =
      msg.kind === 'outreach'
        ? 'outreach'
        : msg.kind === 'bump'
          ? 'bump'
          : msg.kind === 'schedule' || msg.kind === 'reply'
            ? 'schedule'
            : msg.kind === 'thank_you'
              ? 'thank_you'
              : msg.kind === 'nurture'
                ? 'nurture'
                : 'other';
    await evaluateTrigger(chat, { type: 'outbound_sent', kind }, { table: 'outbound', id: msg.id }, now);
  }
  await recomputePersonStrength(msg.personId, now);
  await evaluateImmediateSuggestions(user.id, { personId: msg.personId, chatId: chat?.id }, now);
  return { ok: true, handoffUrl };
}

export async function dismissSuggestion(userId: string, s: Suggestion, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await db.suggestions.update(s.id, { status: 'dismissed', decidedAt: now });
  await feedback(userId, 'dismiss', {
    suggestionId: s.id,
    reason: `${reason}|${s.kind}:${s.personId ?? ''}`,
  });
  if (s.outboundMessageId) await db.outbound.update(s.outboundMessageId, { status: 'cancelled' });
}

export async function snoozeSuggestion(userId: string, s: Suggestion, days: number): Promise<void> {
  const until = new Date();
  until.setDate(until.getDate() + days);
  until.setHours(6, 0, 0, 0);
  await db.suggestions.update(s.id, {
    status: 'snoozed',
    snoozedUntil: until.toISOString(),
    decidedAt: new Date().toISOString(),
  });
  await feedback(userId, 'snooze', { suggestionId: s.id, reason: `${days}d` });
}
