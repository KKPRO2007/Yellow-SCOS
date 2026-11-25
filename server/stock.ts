import type { Db, Query } from './db.js';
import { getAnalysis } from './analytics.js';
import { HttpError } from './errors.js';
import { PRICES, RECIPES, UNITS } from './seed.js';

// Live stock. Every order uses up raw ingredients through the recipes, a
// cancel gives them back, and an item sells out on its own when any of its
// ingredients can't cover one more portion.

export interface StockRow {
  name: string;
  unit: string;
  onHand: number;
  reorderLevel: number;
  price: number;
  status: 'ok' | 'low' | 'out';
  usedBy: string[];
}

const round = (v: number, unit: string) => (unit === 'kg' || unit === 'L' ? Math.round(v * 1000) / 1000 : Math.ceil(v));

/** Raw ingredients needed for these menu lines (item id -> qty). */
export function needFor(lines: Map<string, number>): Map<string, number> {
  const need = new Map<string, number>();
  for (const [id, qty] of lines) for (const [name, per] of Object.entries(RECIPES[id] ?? {})) need.set(name, (need.get(name) ?? 0) + per * qty);
  return need;
}

export async function loadStock(q: Query): Promise<StockRow[]> {
  const rows = await q<{ name: string; unit: string; on_hand: string; reorder_level: string; price: string }>(
    `SELECT name, unit, on_hand, reorder_level, price FROM ingredients ORDER BY name`,
  );
  return rows.map((r) => {
    const onHand = Number(r.on_hand);
    const reorderLevel = Number(r.reorder_level);
    const usedBy = Object.entries(RECIPES)
      .filter(([, rec]) => r.name in rec)
      .map(([id]) => id);
    const minPortion = Math.min(...usedBy.map((id) => RECIPES[id][r.name]));
    return {
      name: r.name,
      unit: r.unit,
      onHand,
      reorderLevel,
      price: Number(r.price),
      status: onHand < minPortion ? 'out' : onHand <= reorderLevel ? 'low' : 'ok',
      usedBy,
    };
  });
}

/** Portions of each menu item the current stock can still make (null = not tracked). */
export function portionsLeft(stock: StockRow[]): Record<string, number | null> {
  const by = new Map(stock.map((s) => [s.name, s.onHand]));
  const out: Record<string, number | null> = {};
  for (const [id, rec] of Object.entries(RECIPES)) {
    const counts = Object.entries(rec)
      .filter(([name]) => by.has(name))
      .map(([name, per]) => Math.floor((by.get(name)! + 1e-9) / per));
    out[id] = counts.length ? Math.min(...counts) : null;
  }
  return out;
}

/**
 * Morning delivery: stock each ingredient for the day's upper forecast plus
 * 15%. Paneer and gulab jamun arrive short on purpose so the demo shows a
 * low-stock alert and an item selling out during the lunch rush.
 */
export async function restockForDay(db: Db) {
  const a = await getAnalysis(db);
  const day = a.stock.days.today ? 'today' : 'tomorrow';
  const short: Record<string, number> = { Paneer: 0.45, 'Gulab jamun (ready)': 0.5 };
  for (const g of a.stock.ingredients) {
    const need = Math.max(g[day], 1);
    const onHand = round(need * (short[g.name] ?? 1.15), g.unit);
    await db.query(
      `INSERT INTO ingredients (name, unit, on_hand, reorder_level, price) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE SET unit = EXCLUDED.unit, on_hand = EXCLUDED.on_hand,
         reorder_level = EXCLUDED.reorder_level, price = EXCLUDED.price, updated_at = now()`,
      [g.name, g.unit, onHand, round(need * 0.25, g.unit), PRICES[g.name] ?? 0],
    );
  }
}

/**
 * Inside the order transaction: take the ingredients or refuse. Each update is
 * conditional ("on_hand >= need") and runs in name order, so concurrent orders
 * never drive stock negative and never deadlock. Returns ingredients that just
 * crossed their reorder level.
 */
export async function takeStock(q: Query, lines: Map<string, number>, names: Record<string, string>) {
  const need = needFor(lines);
  if (!need.size) return [];
  const tracked = new Set(
    (await q<{ name: string }>(`SELECT name FROM ingredients WHERE name = ANY($1)`, [[...need.keys()]])).map((r) => r.name),
  );
  const low: { name: string; onHand: number; unit: string }[] = [];
  for (const name of [...need.keys()].sort()) {
    if (!tracked.has(name)) continue;
    const amount = need.get(name)!;
    const [row] = await q<{ on_hand: string; reorder_level: string; unit: string }>(
      `UPDATE ingredients SET on_hand = on_hand - $2, updated_at = now()
        WHERE name = $1 AND on_hand >= $2 RETURNING on_hand, reorder_level, unit`,
      [name, amount],
    );
    if (!row) {
      const items = [...lines.keys()].filter((id) => RECIPES[id]?.[name]).map((id) => names[id] ?? id);
      throw new HttpError(409, 'OUT_OF_STOCK', `${items.join(' and ')} just ran out (no ${name.toLowerCase()} left). Try something else.`, {
        ingredient: name,
        itemIds: [...lines.keys()].filter((id) => RECIPES[id]?.[name]),
      });
    }
    const after = Number(row.on_hand);
    const level = Number(row.reorder_level);
    if (after <= level && after + amount > level) low.push({ name, onHand: after, unit: row.unit });
  }
  return low;
}

/** Give back what a cancelled order used. */
export async function returnStock(q: Query, orderId: number) {
  const items = await q<{ item_id: string; qty: number }>(`SELECT item_id, qty FROM order_items WHERE order_id = $1`, [orderId]);
  const lines = new Map<string, number>();
  for (const i of items) lines.set(i.item_id, (lines.get(i.item_id) ?? 0) + i.qty);
  for (const [name, amount] of needFor(lines))
    await q(`UPDATE ingredients SET on_hand = on_hand + $2, updated_at = now() WHERE name = $1`, [name, amount]);
}

export interface PoLine {
  ingredient: string;
  unit: string;
  onHand: number;
  needTomorrow: number;
  qty: number;
  unitPrice: number;
  total: number;
}

/** What to buy so tomorrow is covered (upper forecast + 15%), cheapest exact numbers first. */
export async function purchaseLines(db: Db): Promise<{ lines: PoLine[]; total: number; forDate: string }> {
  const a = await getAnalysis(db);
  const stock = await loadStock(db.query);
  const by = new Map(stock.map((s) => [s.name, s]));
  const lines: PoLine[] = [];
  for (const g of a.stock.ingredients) {
    const unit = UNITS[g.name] ?? g.unit;
    const onHand = by.get(g.name)?.onHand ?? 0;
    const qty = round(Math.max(0, g.tomorrow * 1.15 - onHand), unit);
    if (qty <= 0) continue;
    const unitPrice = PRICES[g.name] ?? 0;
    lines.push({ ingredient: g.name, unit, onHand: round(onHand, unit), needTomorrow: g.tomorrow, qty, unitPrice, total: Math.round(qty * unitPrice) });
  }
  lines.sort((x, y) => y.total - x.total);
  return { lines, total: lines.reduce((s, l) => s + l.total, 0), forDate: a.stock.days.tomorrow };
}
