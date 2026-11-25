// The 90-minute gate: fill the 1:00–1:15 pm slot, then one more booking must
// be refused with the next slot offered. Also checks the race: many buyers
// hitting the last places at once never overbook.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { connect, type Db } from '../server/db.js';
import { placeOrder, slotBoard } from '../server/ordering.js';
import { HttpError } from '../server/ordering.js';

// Today's slots start part-filled with sample bookings (as in the demo), so
// the tests count what is left rather than assume an empty slot.
process.env.AI_DISABLED = 'true';
let db: Db;

before(async () => {
  db = await connect('');
  await createApp(db);
});
after(() => db.close());

const order = (slot: string) => placeOrder(db, { userId: null, slot, items: [{ id: 'samosa', qty: 1 }] });

test('gate: full 13:00 slot refuses and offers 13:15', async () => {
  const left = (await slotBoard(db)).find((s) => s.slot === '13:00')!.remaining;
  for (let i = 0; i < left; i++) await order('13:00');
  const full = (await slotBoard(db)).find((s) => s.slot === '13:00')!;
  assert.equal(full.status, 'full');
  await assert.rejects(order('13:00'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'SLOT_FULL');
    assert.equal((err.extra.nextSlot as { slot: string }).slot, '13:15');
    return true;
  });
});

test('no overbooking under a burst of concurrent orders', async () => {
  const before = (await slotBoard(db)).find((s) => s.slot === '14:00')!;
  const results = await Promise.allSettled(Array.from({ length: before.remaining + 15 }, () => order('14:00')));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const refused = results.filter((r) => r.status === 'rejected' && (r.reason as HttpError).code === 'SLOT_FULL').length;
  assert.equal(ok, before.remaining);
  assert.equal(refused, 15);
  const [{ n }] = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM orders WHERE slot_start = '14:00' AND service_date = (SELECT MAX(service_date) FROM orders) AND status <> 'cancelled'`,
  );
  assert.equal(n, before.capacity);
});

test('rejects bad input', async () => {
  await assert.rejects(placeOrder(db, { userId: null, slot: '13:07', items: [{ id: 'samosa', qty: 1 }] }), /does not exist/);
  await assert.rejects(placeOrder(db, { userId: null, slot: '11:00', items: [] }), /at least one/);
  await assert.rejects(placeOrder(db, { userId: null, slot: '11:00', items: [{ id: 'pizza', qty: 1 }] }), /Unknown item/);
  await assert.rejects(placeOrder(db, { userId: null, slot: '11:00', items: [{ id: 'samosa', qty: 13 }] }), /Up to 12/);
});
