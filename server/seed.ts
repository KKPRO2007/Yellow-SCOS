import type { Db, Query } from './db.js';
import { hashPassword } from './auth.js';
import { DOW_NAMES, SLOT_STARTS, SLOT_LEN, addDays, dowOf, hhmm, isOperating, localNow, localToDate, toMin } from './time.js';

// ---------------------------------------------------------------- menu
// demand: relative popularity. dow: weekday multipliers (0=Sun..6=Sat).
// meal: true -> follows the lunch curve hard; false -> flatter snack curve.
export const MENU = [
  { id: 'samosa', name: 'Samosa (2 pc)', category: 'Snacks', price: 20, cost: 8, prep: 2, demand: 1.6, dow: { 5: 1.2 }, meal: false },
  { id: 'vada-pav', name: 'Vada Pav', category: 'Snacks', price: 20, cost: 8, prep: 2, demand: 1.1, dow: { 2: 1.2 }, meal: false },
  { id: 'veg-puff', name: 'Veg Puff', category: 'Snacks', price: 25, cost: 11, prep: 3, demand: 0.7, dow: {}, meal: false },
  { id: 'maggi', name: 'Masala Maggi', category: 'Snacks', price: 40, cost: 16, prep: 5, demand: 0.8, dow: { 6: 1.5 }, meal: false },
  { id: 'masala-dosa', name: 'Masala Dosa', category: 'Meals', price: 60, cost: 22, prep: 6, demand: 0.9, dow: { 1: 1.4 }, meal: true },
  { id: 'veg-thali', name: 'Veg Thali', category: 'Meals', price: 90, cost: 38, prep: 4, demand: 1.0, dow: { 6: 0.6 }, meal: true },
  { id: 'chole-bhature', name: 'Chole Bhature', category: 'Meals', price: 70, cost: 27, prep: 5, demand: 0.8, dow: { 3: 1.6 }, meal: true },
  { id: 'veg-biryani', name: 'Veg Biryani', category: 'Meals', price: 80, cost: 32, prep: 4, demand: 0.9, dow: { 5: 1.7 }, meal: true },
  { id: 'paneer-wrap', name: 'Paneer Wrap', category: 'Meals', price: 70, cost: 30, prep: 5, demand: 0.7, dow: { 4: 1.3 }, meal: true },
  { id: 'chai', name: 'Cutting Chai', category: 'Drinks', price: 10, cost: 4, prep: 1, demand: 1.5, dow: {}, meal: false },
  { id: 'cold-coffee', name: 'Cold Coffee', category: 'Drinks', price: 45, cost: 18, prep: 2, demand: 0.6, dow: { 6: 1.3 }, meal: false },
  { id: 'lime-soda', name: 'Lime Soda', category: 'Drinks', price: 30, cost: 9, prep: 1, demand: 0.6, dow: {}, meal: false },
  { id: 'gulab-jamun', name: 'Gulab Jamun (2 pc)', category: 'Desserts', price: 30, cost: 11, prep: 1, demand: 0.4, dow: {}, meal: false },
] as const;

// Items people add alongside another one (probability of the add-on).
const COMPANIONS: Record<string, [string, number][]> = {
  samosa: [['chai', 0.45]],
  'vada-pav': [['chai', 0.35]],
  'masala-dosa': [['chai', 0.3]],
  'chole-bhature': [['lime-soda', 0.42]],
  'veg-biryani': [['gulab-jamun', 0.34], ['lime-soda', 0.15]],
  'veg-thali': [['lime-soda', 0.2]],
  maggi: [['cold-coffee', 0.32]],
  'paneer-wrap': [['cold-coffee', 0.3]],
};

const DAY_FACTOR: Record<number, number> = { 1: 1.0, 2: 0.97, 3: 1.05, 4: 0.95, 5: 1.12, 6: 0.62 };
const BASE_ORDERS = 470;
export const HISTORY_DAYS = 30;

// ---------------------------------------------------------------- PRNG
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand: () => number) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}
function pick<T>(rand: () => number, items: T[], weights: number[]): T {
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) <= 0) return items[i];
  return items[items.length - 1];
}

function slotWeight(start: string, meal: boolean) {
  const mid = toMin(start) + SLOT_LEN / 2;
  const lunch = Math.exp(-((mid - 785) ** 2) / (2 * 28 ** 2)); // peak ~1:05 pm
  const morning = Math.exp(-((mid - 690) ** 2) / (2 * 20 ** 2)); // 11:30 tea break
  return meal ? 0.15 + 3.2 * lunch + 0.2 * morning : 0.45 + 2.2 * lunch + 0.9 * morning;
}

export interface GenOrder {
  date: string;
  minute: number;
  slot: string;
  items: { itemId: string; qty: number; price: number }[];
}

/** 30 operating days (Mon–Sat) of fake orders ending the day before `today`. */
export function generateHistory(today: string, days = HISTORY_DAYS, seed = 2026): GenOrder[] {
  const rand = mulberry32(seed);
  const dates: string[] = [];
  for (let d = addDays(today, -1); dates.length < days; d = addDays(d, -1)) if (isOperating(d)) dates.unshift(d);

  const orderSlotWeights = SLOT_STARTS.map((s) => slotWeight(s, true) * 0.6 + slotWeight(s, false) * 0.4);
  const out: GenOrder[] = [];

  dates.forEach((date, i) => {
    const dow = dowOf(date);
    let factor = DAY_FACTOR[dow] * (1 + 0.004 * i) * Math.exp(0.06 * gauss(rand));
    if (i === 11) factor *= 0.7; // sports day: half the college is on the ground
    if (i === 22) factor *= 1.25; // fest day
    const n = Math.round(BASE_ORDERS * factor);
    const itemNoise = Object.fromEntries(MENU.map((m) => [m.id, Math.exp(0.1 * gauss(rand))]));

    for (let k = 0; k < n; k++) {
      const slot = pick(rand, SLOT_STARTS, orderSlotWeights);
      const minute = toMin(slot) + Math.floor(rand() * SLOT_LEN);
      const weights = MENU.map(
        (m) => m.demand * ((m.dow as Record<number, number>)[dow] ?? 1) * itemNoise[m.id] * slotWeight(slot, m.meal),
      );
      const main = pick(rand, [...MENU], weights);
      const lines = new Map<string, number>([[main.id, rand() < 0.14 ? 2 : 1]]);
      for (const [companion, p] of COMPANIONS[main.id] ?? []) if (rand() < p) lines.set(companion, 1);
      if (rand() < 0.08) {
        const extra = pick(rand, [...MENU], weights);
        lines.set(extra.id, (lines.get(extra.id) ?? 0) + 1);
      }
      out.push({
        date,
        minute,
        slot,
        items: [...lines].map(([itemId, qty]) => ({ itemId, qty, price: MENU.find((m) => m.id === itemId)!.price })),
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------- seeding
export const DEFAULT_SETTINGS: Record<string, string> = {
  slot_capacity: process.env.SLOT_CAPACITY ?? '30',
  close_past_slots: 'false',
  seed_bookings: process.env.SEED_BOOKINGS ?? 'true',
};

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo1234';
export const DEMO_USERS = [
  { name: 'Krishna', email: 'buyer@demo.test', role: 'buyer' },
  { name: 'Meera Kitchen', email: 'seller@demo.test', role: 'seller' },
  { name: 'Ravi Shopkeeper', email: 'admin@demo.test', role: 'admin' },
] as const;

/**
 * Idempotent. Runs inside one transaction holding an advisory lock, so two
 * serverless instances booting at once can't both insert history. It also
 * tops history up to yesterday, so a deployed demo keeps 30 fresh days.
 */
export async function seed(db: Db, today = localNow().date) {
  await db.tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(7311)`);
    for (const [i, m] of MENU.entries()) {
      await q(
        `INSERT INTO menu_items (id, name, category, price, cost, prep_minutes, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET cost = COALESCE(menu_items.cost, EXCLUDED.cost)`,
        [m.id, m.name, m.category, m.price, m.cost, m.prep, i],
      );
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await q(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [k, v]);
    }
    const existing = await q<{ email: string }>(`SELECT email FROM users WHERE email = ANY($1)`, [DEMO_USERS.map((u) => u.email)]);
    for (const u of DEMO_USERS) {
      if (existing.some((e) => e.email === u.email)) continue;
      await q(`INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING`, [
        u.name,
        u.email,
        hashPassword(DEMO_PASSWORD),
        u.role,
      ]);
    }

    // Days that already have any orders (history or real app orders) are kept as they are.
    const have = new Set((await q<{ d: string }>(`SELECT DISTINCT service_date AS d FROM orders WHERE service_date < $1`, [today])).map((r) => r.d));
    const missing = generateHistory(today).filter((o) => !have.has(o.date));
    if (missing.length) await insertHistory(q, missing);
  });
}

async function insertHistory(q: Query, orders: GenOrder[]) {
  const [{ maxid }] = await q<{ maxid: number }>(`SELECT COALESCE(MAX(id),0)::int AS maxid FROM orders`);
  let id = maxid;
  const tokens = new Map<string, number>();
  const BATCH = 800;
  for (let b = 0; b < orders.length; b += BATCH) {
    const chunk = orders.slice(b, b + BATCH);
    const oVals: unknown[] = [];
    const oRows: string[] = [];
    const iVals: unknown[] = [];
    const iRows: string[] = [];
    for (const o of chunk) {
      id++;
      const token = (tokens.get(o.date) ?? 0) + 1;
      tokens.set(o.date, token);
      const total = o.items.reduce((s, it) => s + it.qty * it.price, 0);
      const placed = localToDate(o.date, o.minute - 20);
      const ready = localToDate(o.date, o.minute);
      const p = oVals.length;
      oRows.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},'collected',$${p + 6},$${p + 7},$${p + 7},'history')`);
      oVals.push(id, token, o.date, o.slot, placed, total, ready);
      for (const it of o.items) {
        const k = iVals.length;
        iRows.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4})`);
        iVals.push(id, it.itemId, it.qty, it.price);
      }
    }
    await q(
      `INSERT INTO orders (id, token_no, service_date, slot_start, placed_at, status, total, ready_eta, ready_at, source)
       VALUES ${oRows.join(',')}`,
      oVals,
    );
    await q(`INSERT INTO order_items (order_id, item_id, qty, unit_price) VALUES ${iRows.join(',')}`, iVals);
  }
  await q(`SELECT setval(pg_get_serial_sequence('orders','id'), (SELECT MAX(id) FROM orders))`);
  for (const [date, n] of tokens) {
    await q(
      `INSERT INTO day_counters (service_date, n) VALUES ($1,$2)
       ON CONFLICT (service_date) DO UPDATE SET n = GREATEST(day_counters.n, EXCLUDED.n)`,
      [date, n],
    );
  }
}

// ---------------------------------------------------------------- recipes
// Raw stock used per unit sold. Turns the item forecast into a shopping list.
export const UNITS: Record<string, string> = {
  Potatoes: 'kg', 'Maida (flour)': 'kg', 'Cooking oil': 'L', Pav: 'pcs', Besan: 'kg', 'Puff pastry': 'sheets',
  'Mixed veg': 'kg', 'Noodle packs': 'packs', 'Dosa batter': 'kg', Rice: 'kg', Dal: 'kg', 'Atta (wheat)': 'kg',
  Chickpeas: 'kg', Paneer: 'kg', Milk: 'L', 'Tea leaves': 'kg', Sugar: 'kg', Coffee: 'kg', Limes: 'pcs', Soda: 'L',
  'Gulab jamun (ready)': 'pcs',
};
export const RECIPES: Record<string, Record<string, number>> = {
  samosa: { Potatoes: 0.08, 'Maida (flour)': 0.05, 'Cooking oil': 0.03 },
  'vada-pav': { Potatoes: 0.08, Pav: 1, Besan: 0.03, 'Cooking oil': 0.03 },
  'veg-puff': { 'Puff pastry': 1, 'Mixed veg': 0.05 },
  maggi: { 'Noodle packs': 1, 'Mixed veg': 0.03 },
  'masala-dosa': { 'Dosa batter': 0.15, Potatoes: 0.1, 'Cooking oil': 0.02 },
  'veg-thali': { Rice: 0.15, Dal: 0.06, 'Mixed veg': 0.15, 'Atta (wheat)': 0.08 },
  'chole-bhature': { Chickpeas: 0.08, 'Maida (flour)': 0.1, 'Cooking oil': 0.05 },
  'veg-biryani': { Rice: 0.18, 'Mixed veg': 0.1, 'Cooking oil': 0.02 },
  'paneer-wrap': { Paneer: 0.07, 'Maida (flour)': 0.06, 'Mixed veg': 0.04 },
  chai: { Milk: 0.08, 'Tea leaves': 0.004, Sugar: 0.01 },
  'cold-coffee': { Milk: 0.2, Coffee: 0.008, Sugar: 0.02 },
  'lime-soda': { Limes: 1, Soda: 0.25, Sugar: 0.015 },
  'gulab-jamun': { 'Gulab jamun (ready)': 2 },
};

/** Plain export for the data analyst: one row per order line. */
export function historyCsv(orders: GenOrder[]): string {
  const rows = ['date,weekday,time,slot,item,quantity,unit_price,line_total'];
  for (const o of orders)
    for (const it of o.items)
      rows.push([o.date, DOW_NAMES[dowOf(o.date)], hhmm(o.minute), o.slot, it.itemId, it.qty, it.price, it.qty * it.price].join(','));
  return rows.join('\n');
}
