// Live stock, group orders and cancels.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { connect, type Db } from '../server/db.js';
import { HttpError, placeOrder, setStatus } from '../server/ordering.js';
import { loadStock, portionsLeft } from '../server/stock.js';

process.env.AI_DISABLED = 'true';
let db: Db;

before(async () => {
  db = await connect('');
  await createApp(db);
});
after(() => db.close());

const wrap = (slot = '11:00') => placeOrder(db, { userId: null, slot, items: [{ id: 'paneer-wrap', qty: 1 }] });
const paneerLeft = async () => portionsLeft(await loadStock(db.query))['paneer-wrap'];

test('stock never oversells, even under a burst', async () => {
  await db.query(`UPDATE ingredients SET on_hand = 0.21 WHERE name = 'Paneer'`); // 3 wraps at 0.07 kg
  assert.equal(await paneerLeft(), 3);
  const slots = ['11:00', '11:15', '11:30', '11:45', '12:00', '12:15', '14:30', '14:45', '11:00', '11:15'];
  const results = await Promise.allSettled(slots.map((s) => wrap(s)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const out = results.filter((r) => r.status === 'rejected' && (r.reason as HttpError).code === 'OUT_OF_STOCK').length;
  assert.equal(ok, 3);
  assert.equal(out, 7);
  assert.equal(await paneerLeft(), 0);
});

test('a refused order does not hold a slot place', async () => {
  const before = (await db.query<{ booked: number }>(`SELECT booked FROM slots WHERE slot_start = '14:45' ORDER BY service_date DESC LIMIT 1`))[0]?.booked ?? 0;
  await assert.rejects(wrap('14:45'), /ran out/);
  const afterRows = await db.query<{ booked: number }>(`SELECT booked FROM slots WHERE slot_start = '14:45' ORDER BY service_date DESC LIMIT 1`);
  assert.equal(afterRows[0]?.booked ?? 0, before);
});

test('cancelling gives the stock back', async () => {
  await db.query(`UPDATE ingredients SET on_hand = 0.07 WHERE name = 'Paneer'`);
  const o = await wrap('12:30');
  assert.equal(await paneerLeft(), 0);
  await setStatus(db, o.id, 'cancelled');
  assert.equal(await paneerLeft(), 1);
});

test('group order keeps who each line is for, and caps the group', async () => {
  const o = await placeOrder(db, {
    userId: null,
    slot: '12:45',
    items: [
      { id: 'samosa', qty: 1 },
      { id: 'chai', qty: 1, for: 'Rahul' },
      { id: 'samosa', qty: 2, for: 'Priya' },
    ],
  });
  const rows = await db.query<{ item_id: string; qty: number; for_name: string | null }>(
    `SELECT item_id, qty, for_name FROM order_items WHERE order_id = $1 ORDER BY for_name NULLS FIRST, item_id`,
    [o.id],
  );
  assert.deepEqual(
    rows.map((r) => [r.for_name, r.item_id, r.qty]),
    [
      [null, 'samosa', 1],
      ['Priya', 'samosa', 2],
      ['Rahul', 'chai', 1],
    ],
  );
  const seven = Array.from({ length: 7 }, (_, k) => ({ id: 'chai', qty: 1, for: `Friend ${k}` }));
  await assert.rejects(placeOrder(db, { userId: null, slot: '12:45', items: seven }), /up to 6 people/);
});
