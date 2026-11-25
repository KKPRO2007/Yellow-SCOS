// Data analyst export: the same 30 days of fake orders the app is seeded with.
//   npm run data  ->  data/orders.csv (one row per order line) + data/summary.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateHistory, historyCsv } from '../server/seed.js';
import { DOW_NAMES, SLOT_STARTS, dowOf, slotLabel } from '../server/time.js';
import { localNow } from '../server/time.js';

const orders = generateHistory(localNow().date);
mkdirSync('data', { recursive: true });
writeFileSync('data/orders.csv', historyCsv(orders));

const days = [...new Set(orders.map((o) => o.date))];
const slotAvg = SLOT_STARTS.map((s) => ({ slot: slotLabel(s), avgOrders: +(orders.filter((o) => o.slot === s).length / days.length).toFixed(1) }));
const top5: Record<string, { item: string; avgQty: number }[]> = {};
for (const dow of [1, 2, 3, 4, 5, 6]) {
  const ds = days.filter((d) => dowOf(d) === dow);
  const q = new Map<string, number>();
  for (const o of orders) if (dowOf(o.date) === dow) for (const it of o.items) q.set(it.itemId, (q.get(it.itemId) ?? 0) + it.qty);
  top5[DOW_NAMES[dow]] = [...q].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([item, n]) => ({ item, avgQty: +(n / ds.length).toFixed(1) }));
}
const summary = {
  days: days.length,
  from: days[0],
  to: days[days.length - 1],
  orders: orders.length,
  peakSlots: [...slotAvg].sort((a, b) => b.avgOrders - a.avgOrders).slice(0, 3),
  slotAvg,
  top5ByWeekday: top5,
};
writeFileSync('data/summary.json', JSON.stringify(summary, null, 2));
console.log(`data/orders.csv: ${orders.length} orders over ${days.length} days`);
console.log('peak slots:', summary.peakSlots.map((p) => `${p.slot} (${p.avgOrders})`).join(', '));
