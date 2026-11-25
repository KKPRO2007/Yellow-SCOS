import type { Db, Query } from './db.js';
import { getAnalysis } from './analytics.js';
import { SLOT_LEN, SLOT_STARTS, localNow, localToDate, slotLabel, toMin } from './time.js';

import { HttpError } from './errors.js';
import { restockForDay, returnStock, takeStock } from './stock.js';
export { HttpError };

export async function getSettings(q: Query) {
  const rows = await q<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    slotCapacity: Math.max(1, Number(s.slot_capacity ?? 30)),
    closePastSlots: s.close_past_slots === 'true',
    seedBookings: s.seed_bookings !== 'false',
  };
}

export interface SlotView {
  slot: string;
  label: string;
  capacity: number;
  booked: number;
  remaining: number;
  fill: number;
  status: 'open' | 'busy' | 'full' | 'closed';
  forecastOrders: number;
  quiet: boolean;
}

/** Live slot board for one day, merged with the forecast. */
export async function slotBoard(db: Db, date = localNow().date): Promise<SlotView[]> {
  const settings = await getSettings(db.query);
  const rows = await db.query<{ slot_start: string; capacity: number; booked: number }>(
    `SELECT slot_start, capacity, booked FROM slots WHERE service_date = $1`,
    [date],
  );
  const by = new Map(rows.map((r) => [r.slot_start, r]));
  const plan = (await getAnalysis(db)).todayPlan;
  const now = localNow();
  const views = SLOT_STARTS.map((slot): SlotView => {
    const r = by.get(slot);
    const capacity = r?.capacity ?? settings.slotCapacity;
    const booked = r?.booked ?? 0;
    const closed = settings.closePastSlots && date === now.date && toMin(slot) + SLOT_LEN <= now.minutes;
    const fill = booked / capacity;
    return {
      slot,
      label: slotLabel(slot),
      capacity,
      booked,
      remaining: Math.max(0, capacity - booked),
      fill,
      status: closed ? 'closed' : booked >= capacity ? 'full' : fill >= 0.75 ? 'busy' : 'open',
      forecastOrders: Math.round(plan.date === date ? plan.slots.find((p) => p.slot === slot)?.orders ?? 0 : 0),
      quiet: false,
    };
  });
  const open = views.filter((v) => v.status === 'open' || v.status === 'busy');
  const threshold = [...open].sort((a, b) => a.fill - b.fill)[Math.floor(open.length / 3)]?.fill ?? 0;
  for (const v of open) v.quiet = v.status === 'open' && v.fill <= Math.min(0.5, threshold);
  return views;
}

function nextOpen(views: SlotView[], after: string, count = 3) {
  return views.filter((v) => toMin(v.slot) > toMin(after) && (v.status === 'open' || v.status === 'busy')).slice(0, count);
}

export interface PlaceInput {
  userId: number | null;
  slot: string;
  /** `for` names the friend a line is for in a group order (omit for yourself). */
  items: { id: string; qty: number; for?: string }[];
  source?: 'app' | 'seed';
  date?: string;
}

/**
 * Places an order inside one transaction. The slot place is taken with a
 * single conditional UPDATE ("booked < capacity"), which Postgres serialises
 * on the row lock, so the last place goes to exactly one buyer.
 */
export async function placeOrder(db: Db, input: PlaceInput) {
  const date = input.date ?? localNow().date;
  if (!SLOT_STARTS.includes(input.slot)) throw new HttpError(400, 'BAD_SLOT', 'That pickup slot does not exist.');
  // lines: item id -> total qty; people: "for" name + item id -> qty (group orders).
  const lines = new Map<string, number>();
  const people = new Map<string, { id: string; for: string | null; qty: number }>();
  for (const it of Array.isArray(input.items) ? input.items : []) {
    const qty = Math.floor(Number(it?.qty));
    if (!it?.id || !(qty > 0)) throw new HttpError(400, 'BAD_ITEMS', 'Each item needs an id and a quantity.');
    const who = typeof it.for === 'string' && it.for.trim() ? it.for.trim().slice(0, 30) : null;
    lines.set(it.id, (lines.get(it.id) ?? 0) + qty);
    const key = `${who ?? ''}\u0000${it.id}`;
    people.set(key, { id: it.id, for: who, qty: (people.get(key)?.qty ?? 0) + qty });
  }
  if (!lines.size) throw new HttpError(400, 'EMPTY', 'Add at least one item.');
  const groupSize = new Set([...people.values()].map((p) => p.for ?? '')).size;
  if (groupSize > 6) throw new HttpError(400, 'GROUP_TOO_BIG', 'A group order is for up to 6 people.');
  const maxItems = groupSize > 1 ? 30 : 12;
  if ([...lines.values()].reduce((a, b) => a + b, 0) > maxItems)
    throw new HttpError(400, 'TOO_MANY', `Up to ${maxItems} items per ${groupSize > 1 ? 'group ' : ''}order.`);

  const settings = await getSettings(db.query);
  const now = localNow();
  if (settings.closePastSlots && date === now.date && toMin(input.slot) + SLOT_LEN <= now.minutes) {
    const views = await slotBoard(db, date);
    throw new HttpError(409, 'SLOT_CLOSED', `${slotLabel(input.slot)} has already passed.`, {
      slot: input.slot,
      alternatives: nextOpen(views, hhmmNow(now.minutes)),
      nextSlot: nextOpen(views, hhmmNow(now.minutes), 1)[0] ?? null,
    });
  }

  const menu = await db.query<{ id: string; name: string; price: number; prep_minutes: number; available: boolean }>(
    `SELECT id, name, price, prep_minutes, available FROM menu_items WHERE id = ANY($1)`,
    [[...lines.keys()]],
  );
  for (const id of lines.keys()) {
    const m = menu.find((x) => x.id === id);
    if (!m) throw new HttpError(400, 'UNKNOWN_ITEM', `Unknown item "${id}".`);
    if (!m.available) throw new HttpError(409, 'SOLD_OUT', `${m.name} is sold out right now.`, { itemId: id });
  }

  const subtotal = menu.reduce((s, m) => s + m.price * lines.get(m.id)!, 0);
  const combo = (await getAnalysis(db)).combo;
  const discount =
    combo && combo.items.every((c) => lines.has(c.id)) ? combo.fullPrice - combo.price : 0;
  const prep = Math.max(...menu.map((m) => m.prep_minutes));

  try {
    return await db.tx(async (q) => {
      await q(
        `INSERT INTO slots (service_date, slot_start, capacity) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [date, input.slot, settings.slotCapacity],
      );
      const taken = await q<{ booked: number; capacity: number }>(
        `UPDATE slots SET booked = booked + 1
          WHERE service_date = $1 AND slot_start = $2 AND booked < capacity
          RETURNING booked, capacity`,
        [date, input.slot],
      );
      if (!taken[0]) throw new HttpError(409, 'SLOT_FULL', `${slotLabel(input.slot)} is full.`, { slot: input.slot });

      const lowStock = await takeStock(q, lines, Object.fromEntries(menu.map((m) => [m.id, m.name])));

      const [{ n: token }] = await q<{ n: number }>(
        `INSERT INTO day_counters (service_date, n) VALUES ($1, 1)
         ON CONFLICT (service_date) DO UPDATE SET n = day_counters.n + 1 RETURNING n`,
        [date],
      );

      // Ready time: the kitchen works through a slot's orders across its 15
      // minutes, so the k-th booking is ready roughly k/capacity into it.
      const { booked, capacity } = taken[0];
      const offset = Math.min(SLOT_LEN - 1, Math.floor(((booked - 1) * SLOT_LEN) / capacity));
      let eta = localToDate(date, toMin(input.slot) + offset);
      const earliest = new Date(Date.now() + prep * 60_000);
      if (eta < earliest) eta = earliest;

      const [order] = await q<{ id: number }>(
        `INSERT INTO orders (token_no, user_id, service_date, slot_start, total, discount, ready_eta, source, payment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [token, input.userId, date, input.slot, subtotal - discount, discount, eta, input.source ?? 'app', input.source === 'seed' ? 'counter' : 'unpaid'],
      );
      for (const p of people.values())
        await q(`INSERT INTO order_items (order_id, item_id, qty, unit_price, for_name) VALUES ($1,$2,$3,$4,$5)`, [
          order.id,
          p.id,
          p.qty,
          menu.find((m) => m.id === p.id)!.price,
          p.for,
        ]);
      // Booked it: leave the waitlist for this slot.
      if (input.userId)
        await q(`DELETE FROM waitlist WHERE user_id = $1 AND service_date = $2 AND slot_start = $3`, [input.userId, date, input.slot]);
      return {
        id: order.id,
        token,
        slot: input.slot,
        slotLabel: slotLabel(input.slot),
        total: subtotal - discount,
        discount,
        readyEta: eta.toISOString(),
        items: [...people.values()].map((p) => ({ id: p.id, name: menu.find((m) => m.id === p.id)!.name, qty: p.qty, for: p.for })),
        lowStock,
      };
    });
  } catch (err) {
    if (err instanceof HttpError && err.code === 'SLOT_FULL') {
      const views = await slotBoard(db, date);
      err.extra.alternatives = nextOpen(views, input.slot);
      err.extra.nextSlot = nextOpen(views, input.slot, 1)[0] ?? null;
      const next = err.extra.nextSlot as SlotView | null;
      err.message = next ? `${slotLabel(input.slot)} is full. Next free slot: ${next.label}.` : `${slotLabel(input.slot)} is full and no later slot is free.`;
    }
    throw err;
  }
}

function hhmmNow(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

const TRANSITIONS: Record<string, string[]> = {
  placed: ['cooking', 'ready', 'cancelled'],
  cooking: ['ready', 'cancelled'],
  ready: ['collected'],
  collected: [],
  cancelled: [],
};

export async function setStatus(db: Db, id: number, status: string, byUserId?: number) {
  return db.tx(async (q) => {
    const [o] = await q<{ id: number; status: string; service_date: string; slot_start: string; user_id: number | null }>(
      `SELECT id, status, service_date, slot_start, user_id FROM orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
    if (byUserId !== undefined && o.user_id !== byUserId) throw new HttpError(403, 'FORBIDDEN', 'Not your order.');
    if (!TRANSITIONS[o.status]?.includes(status))
      throw new HttpError(409, 'BAD_TRANSITION', `Order is ${o.status}; it can't move to ${status}.`);
    await q(
      `UPDATE orders SET status = $2, ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE ready_at END WHERE id = $1`,
      [id, status],
    );
    if (status === 'cancelled') {
      await q(`UPDATE slots SET booked = GREATEST(0, booked - 1) WHERE service_date = $1 AND slot_start = $2`, [
        o.service_date,
        o.slot_start,
      ]);
      await returnStock(q, id);
    }
    return { id, status, date: o.service_date, slot: o.slot_start };
  });
}

/** Demo realism: pre-fill today's slots with a share of the forecast. */
export async function seedToday(db: Db, force = false) {
  const settings = await getSettings(db.query);
  const today = localNow().date;
  // Claim today's pre-fill atomically: only one instance (or one reset) wins.
  await db.query(`INSERT INTO settings (key, value) VALUES ('seeded_date', '') ON CONFLICT (key) DO NOTHING`);
  const claimed = await db.query(
    `UPDATE settings SET value = $1 WHERE key = 'seeded_date' AND (value <> $1 OR $2) RETURNING key`,
    [today, force],
  );
  if (!claimed.length) return 0;
  await restockForDay(db); // the morning delivery
  if (!settings.seedBookings) return 0;
  const [{ n }] = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM orders WHERE service_date = $1`, [today]);
  if (n > 0) return 0;
  const plan = (await getAnalysis(db)).todayPlan;
  const menu = await db.query<{ id: string }>(`SELECT id FROM menu_items WHERE available`);
  let placed = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const s of plan.slots) {
    // Sample bookings fill at most half of a slot, so students always have free places.
    const target = Math.min(Math.floor(settings.slotCapacity / 2), Math.round(s.orders * 0.35));
    const ids = Object.entries(s.items).filter(([id]) => menu.some((m) => m.id === id));
    const total = ids.reduce((a, [, v]) => a + v, 0) || 1;
    for (let k = 0; k < target; k++) {
      let r = rand() * total;
      const pickId = ids.find(([, v]) => (r -= v) <= 0)?.[0] ?? ids[0]?.[0];
      if (!pickId) break;
      try {
        await placeOrder(db, { userId: null, slot: s.slot, items: [{ id: pickId, qty: 1 }], source: 'seed', date: today });
        placed++;
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'OUT_OF_STOCK')) throw err;
      }
    }
  }
  return placed;
}
