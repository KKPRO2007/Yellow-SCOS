import express, { type NextFunction, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { aiProviders, briefing, purchaseNote } from './ai.js';
import { getAnalysis, invalidateAnalysis } from './analytics.js';
import { createSession, hashPassword, loadUser, requireRole, verifyPassword } from './auth.js';
import { connect, migrate, type Db } from './db.js';
import { initEvents, publish, stream } from './events.js';
import { HttpError, getSettings, placeOrder, seedToday, setStatus, slotBoard } from './ordering.js';
import { seed } from './seed.js';
import { loadStock, portionsLeft, purchaseLines, restockForDay } from './stock.js';
import { SLOT_LEN, SLOT_STARTS, localNow, slotLabel, toMin } from './time.js';

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export async function createApp(given?: Db) {
  const db: Db = given ?? (await connect());
  initEvents(db, Boolean(process.env.VERCEL) || process.env.EVENTS === 'db');
  await migrate(db);
  await seed(db);
  await seedToday(db);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(loadUser(db));
  const api = express.Router();

  api.get('/health', wrap(async (_req, res) => res.json({ ok: true, db: db.kind, ai: aiProviders(), today: localNow().date })));
  api.get('/stream', stream);

  // ---------------------------------------------------------------- auth
  api.post(
    '/auth/login',
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const [u] = await db.query<{ id: number; name: string; email: string; role: string; password_hash: string }>(
        `SELECT id, name, email, role, password_hash FROM users WHERE email = $1`,
        [email],
      );
      if (!u || !verifyPassword(String(req.body?.password ?? ''), u.password_hash))
        throw new HttpError(401, 'BAD_LOGIN', 'Email or password is wrong.');
      const token = await createSession(db, u.id);
      res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role } });
    }),
  );
  api.post(
    '/auth/register',
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6)
        throw new HttpError(400, 'BAD_INPUT', 'Name, a valid email and a 6+ character password are needed.');
      const exists = await db.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
      if (exists.length) throw new HttpError(409, 'EMAIL_TAKEN', 'That email already has an account.');
      const [u] = await db.query<{ id: number }>(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'buyer') RETURNING id`,
        [name, email, hashPassword(password)],
      );
      const token = await createSession(db, u.id);
      res.status(201).json({ token, user: { id: u.id, name, email, role: 'buyer' } });
    }),
  );
  api.get('/auth/me', requireRole('buyer', 'seller', 'admin'), (req, res) => res.json({ user: req.user }));
  api.post(
    '/auth/logout',
    wrap(async (req, res) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (token) await db.query(`DELETE FROM sessions WHERE token = $1`, [token]);
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- menu & slots (public)
  api.get(
    '/menu',
    wrap(async (_req, res) => {
      const [rows, stock] = await Promise.all([
        db.query<{ id: string; available: boolean }>(
          `SELECT id, name, category, price, prep_minutes AS "prepMinutes", veg, available FROM menu_items ORDER BY sort`,
        ),
        loadStock(db.query),
      ]);
      const left = portionsLeft(stock);
      res.json(
        rows.map((m) => ({
          ...m,
          manualAvailable: m.available,
          left: left[m.id] ?? null,
          available: m.available && (left[m.id] ?? 1) > 0,
          soldOut: !m.available ? 'manual' : (left[m.id] ?? 1) <= 0 ? 'stock' : null,
        })),
      );
    }),
  );
  api.get('/slots', wrap(async (_req, res) => res.json({ date: localNow().date, slots: await slotBoard(db) })));
  api.get('/combo', wrap(async (_req, res) => res.json((await getAnalysis(db)).combo)));

  // ---------------------------------------------------------------- buyer
  api.post(
    '/orders',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const order = await placeOrder(db, { userId: req.user!.id, slot: String(req.body?.slot ?? ''), items: req.body?.items ?? [] });
      const left = portionsLeft(await loadStock(db.query));
      const nearlyOut = order.items.some((i) => (left[i.id] ?? 99) <= 5);
      await Promise.all([
        publish('slots'),
        publish('orders', { kind: 'new', id: order.id, token: order.token, slot: order.slot, slotLabel: order.slotLabel, items: order.items }),
        order.lowStock.length ? publish('stock', { kind: 'low', low: order.lowStock }) : null,
        nearlyOut || order.lowStock.length ? publish('menu') : null,
      ]);
      res.status(201).json(order);
    }),
  );
  api.get(
    '/orders/mine',
    requireRole('buyer'),
    wrap(async (req, res) => res.json(await ordersQuery(db, `o.user_id = $1 AND o.service_date >= $2`, [req.user!.id, recentDate()]))),
  );
  api.post(
    '/orders/:id/cancel',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const out = await setStatus(db, Number(req.params.id), 'cancelled', req.user!.id);
      await Promise.all([publish('slots'), publish('orders'), publish('menu'), notifyWaitlist(out.date, out.slot)]);
      res.json(out);
    }),
  );

  // ---------------------------------------------------------------- "your usual"
  api.get(
    '/orders/usual',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const rows = await db.query<{ slot: string; sig: string }>(
        `SELECT o.slot_start AS slot, string_agg(oi.item_id || ':' || oi.qty, ',' ORDER BY oi.item_id) AS sig
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.user_id = $1 AND o.status <> 'cancelled' AND oi.for_name IS NULL
          GROUP BY o.id`,
        [req.user!.id],
      );
      const bySig = new Map<string, string[]>();
      for (const r of rows) bySig.set(r.sig, [...(bySig.get(r.sig) ?? []), r.slot]);
      const best = [...bySig].sort((a, b) => b[1].length - a[1].length)[0];
      if (!best || best[1].length < 2) return res.json(null);
      const slotCount = new Map<string, number>();
      for (const sl of best[1]) slotCount.set(sl, (slotCount.get(sl) ?? 0) + 1);
      const slot = [...slotCount].sort((a, b) => b[1] - a[1])[0][0];
      const parts = best[0].split(',').map((x) => x.split(':'));
      const menu = await db.query<{ id: string; name: string; price: number }>(`SELECT id, name, price FROM menu_items WHERE id = ANY($1)`, [
        parts.map((x) => x[0]),
      ]);
      const items = parts
        .map(([id, qty]) => ({ id, qty: Number(qty), name: menu.find((m) => m.id === id)?.name ?? id, price: menu.find((m) => m.id === id)?.price ?? 0 }))
        .filter((i) => menu.some((m) => m.id === i.id));
      res.json({ items, slot, slotLabel: slotLabel(slot), times: best[1].length, total: items.reduce((t, i) => t + i.price * i.qty, 0) });
    }),
  );

  // ---------------------------------------------------------------- waitlist
  async function notifyWaitlist(date: string, slot: string) {
    const [w] = await db.query<{ user_id: number }>(
      `UPDATE waitlist SET notified_at = now()
        WHERE (user_id, service_date, slot_start) IN (
          SELECT user_id, service_date, slot_start FROM waitlist
           WHERE service_date = $1 AND slot_start = $2 AND notified_at IS NULL
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING user_id`,
      [date, slot],
    );
    if (w) await publish('orders', { kind: 'waitlist', userId: w.user_id, slot, slotLabel: slotLabel(slot) });
  }
  const waitlistFor = async (userId: number) =>
    (
      await db.query<{ slot: string; notified: boolean; position: number }>(
        `SELECT w.slot_start AS slot, w.notified_at IS NOT NULL AS notified,
                (SELECT COUNT(*)::int FROM waitlist x WHERE x.service_date = w.service_date AND x.slot_start = w.slot_start
                   AND x.notified_at IS NULL AND x.created_at <= w.created_at) AS position
           FROM waitlist w WHERE w.user_id = $1 AND w.service_date = $2 ORDER BY w.slot_start`,
        [userId, localNow().date],
      )
    ).map((r) => ({ ...r, slotLabel: slotLabel(r.slot) }));
  api.get('/waitlist/mine', requireRole('buyer'), wrap(async (req, res) => res.json(await waitlistFor(req.user!.id))));
  api.post(
    '/waitlist',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const slot = String(req.body?.slot ?? '');
      if (!SLOT_STARTS.includes(slot)) throw new HttpError(400, 'BAD_SLOT', 'That pickup slot does not exist.');
      const [{ n }] = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM waitlist WHERE user_id = $1 AND service_date = $2`, [
        req.user!.id,
        localNow().date,
      ]);
      if (n >= 3) throw new HttpError(409, 'WAITLIST_LIMIT', 'You can wait for up to 3 slots at a time.');
      await db.query(
        `INSERT INTO waitlist (user_id, service_date, slot_start) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, service_date, slot_start) DO UPDATE SET notified_at = NULL, created_at = now()`,
        [req.user!.id, localNow().date, slot],
      );
      res.status(201).json(await waitlistFor(req.user!.id));
    }),
  );
  api.delete(
    '/waitlist/:slot',
    requireRole('buyer'),
    wrap(async (req, res) => {
      await db.query(`DELETE FROM waitlist WHERE user_id = $1 AND service_date = $2 AND slot_start = $3`, [
        req.user!.id,
        localNow().date,
        String(req.params.slot),
      ]);
      res.json(await waitlistFor(req.user!.id));
    }),
  );

  // ---------------------------------------------------------------- UPI payments
  // Real Razorpay checkout when RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are set
  // (test keys work). Without them, a clearly labelled test flow: no money moves.
  const rzp = () =>
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET } : null;
  async function ownOrder(id: number, userId: number) {
    const [o] = await db.query<{ id: number; token_no: number; total: number; status: string; payment_status: string; payment_ref: string | null; user_id: number }>(
      `SELECT id, token_no, total, status, payment_status, payment_ref, user_id FROM orders WHERE id = $1`,
      [id],
    );
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
    if (o.user_id !== userId) throw new HttpError(403, 'FORBIDDEN', 'Not your order.');
    if (o.status === 'cancelled') throw new HttpError(409, 'CANCELLED', 'This order was cancelled.');
    if (o.payment_status === 'paid') throw new HttpError(409, 'ALREADY_PAID', 'This order is already paid.');
    return o;
  }
  async function markPaid(id: number, ref: string, status: 'paid' | 'counter' = 'paid') {
    await db.query(`UPDATE orders SET payment_status = $2, payment_ref = $3, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END WHERE id = $1`, [
      id,
      status,
      ref,
    ]);
    await publish('orders', { kind: 'paid', id, status });
  }
  api.post(
    '/orders/:id/pay',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const o = await ownOrder(Number(req.params.id), req.user!.id);
      const keys = rzp();
      if (!keys) return res.json({ mode: 'test', amount: o.total, token: o.token_no });
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${keys.id}:${keys.secret}`).toString('base64')}` },
        body: JSON.stringify({ amount: o.total * 100, currency: 'INR', receipt: `yellow-${o.id}`, notes: { token: String(o.token_no) } }),
      });
      const j = (await r.json()) as { id?: string; error?: { description?: string } };
      if (!r.ok || !j.id) throw new HttpError(502, 'PAYMENT_GATEWAY', `Razorpay: ${j.error?.description ?? r.status}`);
      await db.query(`UPDATE orders SET payment_ref = $2 WHERE id = $1`, [o.id, j.id]);
      res.json({
        mode: 'razorpay',
        keyId: keys.id,
        rzpOrderId: j.id,
        amount: o.total * 100,
        token: o.token_no,
        prefill: { name: req.user!.name, email: req.user!.email },
      });
    }),
  );
  api.post(
    '/orders/:id/pay/confirm',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const o = await ownOrder(Number(req.params.id), req.user!.id);
      const keys = rzp();
      if (keys) {
        const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body ?? {};
        if (!oid || !pid || !sig || oid !== o.payment_ref) throw new HttpError(400, 'BAD_PAYMENT', 'Payment details do not match this order.');
        const expected = createHmac('sha256', keys.secret).update(`${oid}|${pid}`).digest('hex');
        const a = Buffer.from(expected);
        const b = Buffer.from(String(sig));
        if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(400, 'BAD_SIGNATURE', 'Payment could not be verified.');
        await markPaid(o.id, String(pid));
      } else {
        if (req.body?.test !== true) throw new HttpError(400, 'TEST_ONLY', 'Online payment is in test mode.');
        await markPaid(o.id, `TEST-${randomBytes(4).toString('hex').toUpperCase()}`);
      }
      res.json({ ok: true, mode: keys ? 'razorpay' : 'test' });
    }),
  );
  api.post(
    '/orders/:id/pay-at-counter',
    requireRole('buyer'),
    wrap(async (req, res) => {
      const o = await ownOrder(Number(req.params.id), req.user!.id);
      await markPaid(o.id, 'COUNTER', 'counter');
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- seller (canteen staff)
  api.get(
    '/kitchen',
    requireRole('seller', 'admin'),
    wrap(async (_req, res) => {
      const today = localNow().date;
      const orders = await ordersQuery(db, `o.service_date = $1 AND o.status IN ('placed','cooking','ready')`, [today]);
      const slots = await slotBoard(db);
      const plan = (await getAnalysis(db)).todayPlan;
      const menu = await db.query<{ id: string; name: string }>(`SELECT id, name FROM menu_items ORDER BY sort`);
      const now = localNow().minutes;
      const current = SLOT_STARTS.find((s) => toMin(s) + SLOT_LEN > now) ?? SLOT_STARTS[0];
      const upcoming = SLOT_STARTS.slice(SLOT_STARTS.indexOf(current), SLOT_STARTS.indexOf(current) + 4);
      const cookAhead = upcoming.map((slot) => {
        const view = slots.find((s) => s.slot === slot)!;
        const p = plan.slots.find((s) => s.slot === slot)!;
        // Demand above capacity can't be served in this slot, so scale it down.
        const scale = p.orders > view.capacity ? view.capacity / p.orders : 1;
        const items = menu
          .map((m) => {
            const booked = orders
              .filter((o) => o.slot === slot && o.status !== 'ready')
              .reduce((a, o) => a + o.items.filter((i) => i.id === m.id).reduce((t, i) => t + i.qty, 0), 0);
            const expected = Math.round((p.items[m.id] ?? 0) * scale);
            return { id: m.id, name: m.name, booked, expected, cook: Math.max(booked, expected) };
          })
          .filter((i) => i.cook > 0)
          .sort((a, b) => b.cook - a.cook);
        return { slot, label: slotLabel(slot), booked: view.booked, capacity: view.capacity, items };
      });
      res.json({ today, current, orders, slots, cookAhead });
    }),
  );
  api.patch(
    '/orders/:id/status',
    requireRole('seller', 'admin'),
    wrap(async (req, res) => {
      const out = await setStatus(db, Number(req.params.id), String(req.body?.status ?? ''));
      if (out.status === 'collected')
        await db.query(
          `UPDATE orders SET payment_status = 'paid', payment_ref = COALESCE(payment_ref, 'COUNTER'), paid_at = now()
            WHERE id = $1 AND payment_status <> 'paid'`,
          [out.id],
        );
      await publish('orders', { kind: 'status', id: out.id, status: out.status });
      if (out.status === 'cancelled') await Promise.all([publish('slots'), publish('menu'), notifyWaitlist(out.date, out.slot)]);
      res.json(out);
    }),
  );
  api.patch(
    '/menu/:id',
    requireRole('seller', 'admin'),
    wrap(async (req, res) => {
      const { available, price, cost } = req.body ?? {};
      if (cost !== undefined) {
        if (req.user!.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Only the shopkeeper can change costs.');
        const c = Math.round(Number(cost));
        if (!(c >= 0 && c < 10000)) throw new HttpError(400, 'BAD_COST', 'Cost must be between ₹0 and ₹9999.');
        await db.query(`UPDATE menu_items SET cost = $2 WHERE id = $1`, [req.params.id, c]);
        invalidateAnalysis();
      }
      if (typeof available === 'boolean')
        await db.query(`UPDATE menu_items SET available = $2 WHERE id = $1`, [req.params.id, available]);
      if (price !== undefined) {
        if (req.user!.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Only the shopkeeper can change prices.');
        const p = Math.round(Number(price));
        if (!(p > 0 && p < 10000)) throw new HttpError(400, 'BAD_PRICE', 'Price must be between ₹1 and ₹9999.');
        await db.query(`UPDATE menu_items SET price = $2 WHERE id = $1`, [req.params.id, p]);
        invalidateAnalysis();
      }
      await publish('menu');
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- live stock
  api.get(
    '/stock',
    requireRole('seller', 'admin'),
    wrap(async (_req, res) => {
      const stock = await loadStock(db.query);
      res.json({ stock, left: portionsLeft(stock) });
    }),
  );
  api.post(
    '/stock/restock',
    requireRole('seller', 'admin'),
    wrap(async (req, res) => {
      if (req.body?.all) await restockForDay(db);
      else {
        const name = String(req.body?.name ?? '');
        const qty = Number(req.body?.qty);
        if (!(qty > 0 && qty < 100000)) throw new HttpError(400, 'BAD_QTY', 'Enter a positive quantity.');
        const r = await db.query(`UPDATE ingredients SET on_hand = on_hand + $2, updated_at = now() WHERE name = $1 RETURNING name`, [name, qty]);
        if (!r.length) throw new HttpError(404, 'NOT_FOUND', 'Unknown ingredient.');
      }
      await Promise.all([publish('menu'), publish('stock', { kind: 'restock' })]);
      const stock = await loadStock(db.query);
      res.json({ stock, left: portionsLeft(stock) });
    }),
  );
  api.post(
    '/stock/purchase-order',
    requireRole('admin'),
    wrap(async (_req, res) => {
      const [po, stock] = await Promise.all([purchaseLines(db), loadStock(db.query)]);
      res.json({ ...po, draft: await purchaseNote(po, stock) });
    }),
  );

  // ---------------------------------------------------------------- admin (shopkeeper)
  api.get(
    '/insights',
    requireRole('admin'),
    wrap(async (_req, res) => {
      const a = await getAnalysis(db);
      const [today] = await db.query<{ orders: number; revenue: number; ready: number; collected: number; discount: number; cancelled: number; paidOnline: number; dueAtCounter: number }>(
        `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS orders,
                COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'),0)::int AS revenue,
                COALESCE(SUM(discount) FILTER (WHERE status <> 'cancelled'),0)::int AS discount,
                COUNT(*) FILTER (WHERE status = 'ready')::int AS ready,
                COUNT(*) FILTER (WHERE status = 'collected')::int AS collected,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled' AND payment_status = 'paid' AND payment_ref <> 'COUNTER'),0)::int AS "paidOnline",
                COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled' AND payment_status <> 'paid'),0)::int AS "dueAtCounter"
           FROM orders WHERE service_date = $1`,
        [a.today],
      );
      const [{ cost }] = await db.query<{ cost: number }>(
        `SELECT COALESCE(SUM(oi.qty * COALESCE(m.cost,0)),0)::int AS cost
           FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.item_id
          WHERE o.service_date = $1 AND o.status <> 'cancelled'`,
        [a.today],
      );
      res.json({ ...a, live: { ...today, cost, profit: today.revenue - cost } });
    }),
  );
  api.post(
    '/ai/briefing',
    requireRole('admin'),
    wrap(async (req, res) => res.json(await briefing(await getAnalysis(db), await slotBoard(db), Boolean(req.body?.refresh)))),
  );
  api.get('/admin/settings', requireRole('admin'), wrap(async (_req, res) => res.json(await getSettings(db.query))));
  api.patch(
    '/admin/settings',
    requireRole('admin'),
    wrap(async (req, res) => {
      const { slotCapacity, closePastSlots } = req.body ?? {};
      if (slotCapacity !== undefined) {
        const c = Math.round(Number(slotCapacity));
        if (!(c >= 1 && c <= 500)) throw new HttpError(400, 'BAD_CAPACITY', 'Capacity must be 1–500 orders per slot.');
        await db.query(`UPDATE settings SET value = $1 WHERE key = 'slot_capacity'`, [String(c)]);
        // Apply to today's remaining slots too; never below what's already booked.
        await db.query(`UPDATE slots SET capacity = GREATEST($2, booked) WHERE service_date = $1`, [localNow().date, c]);
      }
      if (typeof closePastSlots === 'boolean')
        await db.query(`UPDATE settings SET value = $1 WHERE key = 'close_past_slots'`, [String(closePastSlots)]);
      await publish('settings');
      await publish('slots');
      res.json(await getSettings(db.query));
    }),
  );
  api.get(
    '/admin/staff',
    requireRole('admin'),
    wrap(async (_req, res) =>
      res.json(await db.query(`SELECT id, name, email, role FROM users WHERE role IN ('seller','admin') ORDER BY role, name`)),
    ),
  );
  api.post(
    '/admin/staff',
    requireRole('admin'),
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6)
        throw new HttpError(400, 'BAD_INPUT', 'Name, a valid email and a 6+ character password are needed.');
      const exists = await db.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
      if (exists.length) throw new HttpError(409, 'EMAIL_TAKEN', 'That email already has an account.');
      const [u] = await db.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'seller') RETURNING id, name, email, role`,
        [name, email, hashPassword(password)],
      );
      res.status(201).json(u);
    }),
  );
  api.post(
    '/admin/reset-today',
    requireRole('admin'),
    wrap(async (req, res) => {
      const today = localNow().date;
      await db.tx(async (q) => {
        await q(`DELETE FROM orders WHERE service_date = $1`, [today]);
        await q(`DELETE FROM slots WHERE service_date = $1`, [today]);
        await q(`DELETE FROM day_counters WHERE service_date = $1`, [today]);
        await q(`DELETE FROM waitlist WHERE service_date = $1`, [today]);
      });
      invalidateAnalysis();
      const seeded = req.body?.seed === false ? (await restockForDay(db), 0) : await seedToday(db, true);
      await Promise.all([publish('slots'), publish('orders'), publish('menu'), publish('stock', { kind: 'restock' })]);
      res.json({ ok: true, seeded });
    }),
  );

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' }));

  // Production: serve the built React app from the same origin.
  const dist = path.resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong on our side.' });
  });

  return { app, db };
}

function recentDate() {
  const d = new Date(Date.now() - 2 * 86_400_000);
  return localNow(d).date;
}

export interface OrderView {
  id: number;
  token: number;
  slot: string;
  slotLabel: string;
  date: string;
  status: string;
  total: number;
  discount: number;
  readyEta: string | null;
  readyAt: string | null;
  placedAt: string;
  customer: string | null;
  payment: 'unpaid' | 'paid' | 'counter';
  items: { id: string; name: string; qty: number; for: string | null }[];
}

async function ordersQuery(db: Db, where: string, params: unknown[]): Promise<OrderView[]> {
  const rows = await db.query<any>(
    `SELECT o.id, o.token_no, o.slot_start, o.service_date, o.status, o.total, o.discount, o.ready_eta, o.ready_at, o.placed_at, o.payment_status,
            u.name AS customer,
            COALESCE(json_agg(json_build_object('id', oi.item_id, 'name', m.name, 'qty', oi.qty, 'for', oi.for_name) ORDER BY oi.for_name NULLS FIRST, m.sort)
                     FILTER (WHERE oi.item_id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN menu_items m ON m.id = oi.item_id
      WHERE ${where}
      GROUP BY o.id, u.name
      ORDER BY o.service_date DESC, o.slot_start, o.token_no`,
    params,
  );
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return rows.map((r) => ({
    id: r.id,
    token: r.token_no,
    slot: r.slot_start,
    slotLabel: slotLabel(r.slot_start),
    date: r.service_date,
    status: r.status,
    total: r.total,
    discount: r.discount,
    readyEta: iso(r.ready_eta),
    readyAt: iso(r.ready_at),
    placedAt: iso(r.placed_at)!,
    customer: r.customer ?? (r.status ? 'Walk-in' : null),
    payment: r.payment_status,
    items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
  }));
}
