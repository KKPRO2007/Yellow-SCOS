// Quick boot + data check against an in-memory database:
import 'dotenv/config';
//   npx tsx scripts/smoke.ts
import { createApp } from '../server/app.js';
import { connect } from '../server/db.js';

const t0 = Date.now();
const db = await connect(''); // force in-memory PGlite
const { app } = await createApp(db);
console.log(`booted in ${Date.now() - t0} ms (db: ${db.kind})`);

const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://localhost:${port}/api`;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

try {
  const health = await call('GET', '/health');
  check('health', health.body.ok === true, `today ${health.body.today}`);

  const menu = await call('GET', '/menu');
  check('menu', menu.body.length === 13, `${menu.body.length} items`);

  const login = async (email: string) => (await call('POST', '/auth/login', { email, password: 'demo1234' })).body.token as string;
  const buyer = await login('buyer@demo.test');
  const seller = await login('seller@demo.test');
  const admin = await login('admin@demo.test');
  check('logins', Boolean(buyer && seller && admin));

  const ins = await call('GET', '/insights', undefined, admin);
  const a = ins.body;
  check('insights', ins.status === 200, `${a.days} days, ${a.totalOrders} orders, ${Math.round(a.avgOrdersPerDay)}/day`);
  console.log('     peak slots:', a.peakSlots.map((p: any) => `${p.label} ${p.avg.toFixed(1)}`).join(' | '));
  console.log('     top 5 Fri:', a.topByDow.Fri?.map((i: any) => i.name).join(', '));
  console.log('     backtest WAPE:', a.backtest && Object.entries(a.backtest).map(([k, v]) => `${k}=${typeof v === 'number' && v < 1 ? (v * 100).toFixed(1) + '%' : v}`).join(' '));
  console.log('     learning curve:', a.learningCurve.map((p: any) => `${p.trainDays}d ${(p.wape * 100).toFixed(1)}%`).join(', '));
  console.log('     combo:', a.combo?.items.map((i: any) => i.name).join(' + '), `₹${a.combo?.price}`, '-', a.combo?.reason);
  console.log('     queue:', `max wait ${a.queue.maxWaitMin.toFixed(1)} min at ${a.queue.worstSlot}`);

  const slots = await call('GET', '/slots');
  const s13 = slots.body.slots.find((s: any) => s.slot === '13:00');
  check('slots', slots.body.slots.length === 16, `13:00 booked ${s13.booked}/${s13.capacity}`);

  // The gate: fill 13:00, then one more must be refused with the next slot offered.
  let placed = 0;
  let refusal: any = null;
  for (let i = 0; i < 100 && !refusal; i++) {
    const r = await call('POST', '/orders', { slot: '13:00', items: [{ id: 'samosa', qty: 1 }] }, buyer);
    if (r.status === 201) placed++;
    else refusal = r;
  }
  check('gate: 13:00 fills then refuses', refusal?.status === 409 && refusal.body.error === 'SLOT_FULL', `placed ${placed}, then ${refusal?.status} ${refusal?.body.error}`);
  check('gate: offers next slot', refusal?.body.nextSlot?.slot === '13:15', refusal?.body.message);

  const mine = await call('GET', '/orders/mine', undefined, buyer);
  check('my orders', mine.body.length === placed, `${mine.body.length}, first ready ${mine.body[0]?.readyEta}`);

  const kitchen = await call('GET', '/kitchen', undefined, seller);
  check('kitchen', kitchen.status === 200, `${kitchen.body.orders.length} open orders, cook-ahead ${kitchen.body.cookAhead.length} slots`);

  const st = await call('PATCH', `/orders/${mine.body[0].id}/status`, { status: 'ready' }, seller);
  check('status -> ready', st.status === 200);

  const forbidden = await call('GET', '/insights', undefined, buyer);
  check('buyer blocked from insights', forbidden.status === 403);

  const brief = await call('POST', '/ai/briefing', {}, admin);
  console.log(JSON.stringify(brief.body, null, 1).slice(0, 2500));
  check('briefing', brief.status === 200, `${brief.body.source}: ${brief.body.headline}${brief.body.note ? ' | ' + brief.body.note : ''}`);
} finally {
  server.close();
  await db.close();
}
