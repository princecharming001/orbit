/**
 * Calendar (§8.3):
 *   POST /calendar/slots {personId?, tz?, count?}  → {slots, tz}: free 30-minute slots on three different days
 *   POST /calendar/book {draftId, slotStart}       → {eventId} with invites sent, or {needsConsent: {url}} the first
 *                                                   time (calendar.events is asked for incrementally)
 */
import { badRequest, json } from '../../_shared/http.ts';
import { bookSlot, slotsFor } from '../../_shared/slots/slots.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

async function slots(ctx: Ctx): Promise<Response> {
  const b = await body(ctx, true);
  if (b.tz !== undefined && typeof b.tz !== 'string') throw badRequest('tz must be an IANA zone');
  const count = b.count === undefined ? undefined : Number(b.count);
  const r = await slotsFor(ctx.services(), ctx.userId!, {
    personId: optUuid(b, 'personId'),
    tz: b.tz as string | undefined,
    count: Number.isFinite(count) ? count : undefined,
  });
  return json(200, { slots: r.slots, tz: r.tz });
}

async function book(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (typeof b.slotStart !== 'string') throw badRequest('slotStart is required');
  const r = await bookSlot(
    ctx.services(),
    ctx.userId!,
    { draftId: uuid(b, 'draftId'), slotStart: b.slotStart },
    ctx.env.appUrl,
  );
  return json(200, r);
}

export const calendarRoutes: Record<string, Route> = {
  '/calendar/slots': { method: 'POST', auth: true, run: slots },
  '/calendar/book': { method: 'POST', auth: true, run: book },
};
