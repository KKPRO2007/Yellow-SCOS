import type { Db } from './db.js';
import { backtest, fit, forecast, learningCurve, type Forecast, type Series } from './ml.js';
import { RECIPES, UNITS } from './seed.js';
import { DOW_NAMES, SLOT_STARTS, dowOf, localNow, nextOperatingDays, slotLabel } from './time.js';

// Everything here reads closed days only (service_date < today), so it can be
// computed once per day and cached. Orders placed through the app become
// history the next morning, so the model keeps learning from real demand.

interface MenuRow {
  id: string;
  name: string;
  category: string;
  price: number;
  cost: number;
}

export interface StockPlan {
  days: { today: string | null; tomorrow: string; week: string[] };
  items: { itemId: string; name: string; today: number; tomorrow: number; week: number }[];
  ingredients: { name: string; unit: string; today: number; tomorrow: number; week: number }[];
}

export interface Money {
  days: { date: string; revenue: number; cost: number; profit: number; discount: number }[];
  items: { itemId: string; name: string; price: number; cost: number; units: number; revenue: number; foodCost: number; profit: number; margin: number }[];
  avgProfitPerDay: number;
  marginPct: number;
}

export interface Analysis {
  today: string;
  days: number;
  firstDay: string;
  lastDay: string;
  totalOrders: number;
  avgOrdersPerDay: number;
  avgRevenuePerDay: number;
  slotAvg: { slot: string; label: string; avg: number }[];
  peakSlots: { slot: string; label: string; avg: number }[];
  topByDow: Record<string, { itemId: string; name: string; avgQty: number }[]>;
  queue: { counterPerSlot: number; maxWaitMin: number; worstSlot: string; waitBySlot: { slot: string; waitMin: number }[] };
  forecast: {
    orders: Forecast[];
    ordersHistory: { date: string; value: number }[];
    items: { itemId: string; name: string; points: Forecast[]; history: { date: string; value: number }[] }[];
  };
  backtest: ReturnType<typeof backtest>;
  learningCurve: ReturnType<typeof learningCurve>;
  todayPlan: {
    date: string;
    dow: string;
    ordersForecast: number;
    slots: { slot: string; orders: number; items: Record<string, number> }[];
  };
  combo: Combo | null;
  stock: StockPlan;
  money: Money;
  insights: string[];
}

export interface Combo {
  items: { id: string; name: string; price: number }[];
  price: number;
  fullPrice: number;
  reason: string;
}

let cache: { key: string; value: Analysis } | null = null;

export function invalidateAnalysis() {
  cache = null;
}

export async function getAnalysis(db: Db): Promise<Analysis> {
  const today = localNow().date;
  if (cache?.key === today) return cache.value;
  const value = await compute(db, today);
  cache = { key: today, value };
  return value;
}

async function compute(db: Db, today: string): Promise<Analysis> {
  const menu = await db.query<MenuRow>(`SELECT id, name, category, price, COALESCE(cost, 0) AS cost FROM menu_items ORDER BY sort`);
  const nameOf = (id: string) => menu.find((m) => m.id === id)?.name ?? id;

  const daily = await db.query<{ d: string; item_id: string; q: number }>(
    `SELECT o.service_date AS d, oi.item_id, SUM(oi.qty)::int AS q
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status <> 'cancelled' AND o.service_date < $1
      GROUP BY 1, 2`,
    [today],
  );
  const perSlot = await db.query<{ d: string; s: string; n: number; rev: number }>(
    `SELECT service_date AS d, slot_start AS s, COUNT(*)::int AS n, SUM(total)::int AS rev
       FROM orders WHERE status <> 'cancelled' AND service_date < $1
      GROUP BY 1, 2`,
    [today],
  );
  const itemSlot = await db.query<{ d: string; s: string; item_id: string; q: number }>(
    `SELECT o.service_date AS d, o.slot_start AS s, oi.item_id, SUM(oi.qty)::int AS q
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status <> 'cancelled' AND o.service_date < $1
      GROUP BY 1, 2, 3`,
    [today],
  );

  const dates = [...new Set(perSlot.map((r) => r.d))].sort();
  const dIndex = new Map(dates.map((d, i) => [d, i]));
  const n = dates.length;
  const dows = dates.map(dowOf);

  // ---- daily series
  const ordersSeries: Series = { dates, dows, values: new Array(n).fill(0) };
  let revenue = 0;
  for (const r of perSlot) {
    ordersSeries.values[dIndex.get(r.d)!] += r.n;
    revenue += r.rev;
  }
  const itemSeries = new Map<string, Series>(menu.map((m) => [m.id, { dates, dows, values: new Array(n).fill(0) }]));
  for (const r of daily) itemSeries.get(r.item_id)!.values[dIndex.get(r.d)!] += r.q;
  const totalOrders = ordersSeries.values.reduce((a, b) => a + b, 0);

  // ---- peak slots
  const slotTotals = new Map(SLOT_STARTS.map((s) => [s, 0]));
  for (const r of perSlot) slotTotals.set(r.s, (slotTotals.get(r.s) ?? 0) + r.n);
  const slotAvg = SLOT_STARTS.map((slot) => ({ slot, label: slotLabel(slot), avg: n ? slotTotals.get(slot)! / n : 0 }));
  const peakSlots = [...slotAvg].sort((a, b) => b.avg - a.avg).slice(0, 3);

  // ---- top 5 items by weekday
  const topByDow: Analysis['topByDow'] = {};
  for (const dow of [1, 2, 3, 4, 5, 6]) {
    const idx = dows.map((d, i) => (d === dow ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    topByDow[DOW_NAMES[dow]] = menu
      .map((m) => ({
        itemId: m.id,
        name: m.name,
        avgQty: idx.reduce((a, i) => a + itemSeries.get(m.id)!.values[i], 0) / idx.length,
      }))
      .sort((a, b) => b.avgQty - a.avgQty)
      .slice(0, 5);
  }

  // ---- what one counter does to the queue (fluid queue, 2 orders/minute)
  const counterPerSlot = 30;
  let backlog = 0;
  const waitBySlot = slotAvg.map(({ slot, avg }) => {
    backlog = Math.max(0, backlog + avg - counterPerSlot);
    return { slot, waitMin: backlog / (counterPerSlot / 15) };
  });
  const worst = waitBySlot.reduce((a, b) => (b.waitMin > a.waitMin ? b : a), waitBySlot[0]);

  // ---- forecasts (next 6 operating days from today)
  const future = nextOperatingDays(today, 6).map((date) => ({ date, dow: dowOf(date) }));
  const runForecast = (s: Series) => {
    const m = fit(s, n);
    return m ? forecast(m, s, n, future) : future.map((f) => ({ ...f, value: 0, low: 0, high: 0 }));
  };
  const ordersFc = runForecast(ordersSeries);
  const itemsFc = menu.map((m) => {
    const s = itemSeries.get(m.id)!;
    return {
      itemId: m.id,
      name: m.name,
      points: runForecast(s),
      history: dates.map((date, i) => ({ date, value: s.values[i] })),
    };
  });

  // ---- today's slot plan: daily forecast x how that weekday spreads over slots
  const todayDow = dowOf(today);
  const todayIdx = future.findIndex((f) => f.date === today);
  const sameDow = new Set(dates.filter((d) => dowOf(d) === todayDow));
  const shareFor = (rows: { d: string; s: string; q: number }[], filter: (r: { d: string }) => boolean) => {
    const by = new Map<string, number>();
    let tot = 0;
    for (const r of rows) if (filter(r)) (by.set(r.s, (by.get(r.s) ?? 0) + r.q), (tot += r.q));
    return (slot: string) => (tot ? (by.get(slot) ?? 0) / tot : 1 / SLOT_STARTS.length);
  };
  const slotRows = perSlot.map((r) => ({ d: r.d, s: r.s, q: r.n }));
  const ordShareDow = shareFor(slotRows, (r) => sameDow.has(r.d));
  const ordShareAll = shareFor(slotRows, () => true);
  const ordersToday = todayIdx >= 0 ? ordersFc[todayIdx].value : 0;
  const itemShare = new Map(
    menu.map((m) => {
      const rows = itemSlot.filter((r) => r.item_id === m.id).map((r) => ({ d: r.d, s: r.s, q: r.q }));
      const dowS = shareFor(rows, (r) => sameDow.has(r.d));
      const allS = shareFor(rows, () => true);
      return [m.id, (slot: string) => 0.7 * dowS(slot) + 0.3 * allS(slot)];
    }),
  );
  const todayPlan = {
    date: today,
    dow: DOW_NAMES[todayDow],
    ordersForecast: ordersToday,
    slots: SLOT_STARTS.map((slot) => ({
      slot,
      orders: ordersToday * (0.7 * ordShareDow(slot) + 0.3 * ordShareAll(slot)),
      items: Object.fromEntries(
        itemsFc.map((f) => [f.itemId, (todayIdx >= 0 ? f.points[todayIdx].value : 0) * itemShare.get(f.itemId)!(slot)]),
      ),
    })),
  };

  const combo = await comboOfDay(db, today, menu);
  const stock = stockPlan(today, future.map((f) => f.date), itemsFc);
  const money = await moneyHistory(db, today, menu);
  const bt = backtest([ordersSeries, ...itemSeries.values()]);
  const lc = learningCurve([...itemSeries.values()]);

  const analysis: Analysis = {
    today,
    days: n,
    firstDay: dates[0] ?? today,
    lastDay: dates[n - 1] ?? today,
    totalOrders,
    avgOrdersPerDay: n ? totalOrders / n : 0,
    avgRevenuePerDay: n ? revenue / n : 0,
    slotAvg,
    peakSlots,
    topByDow,
    queue: { counterPerSlot, maxWaitMin: worst?.waitMin ?? 0, worstSlot: worst?.slot ?? '', waitBySlot },
    forecast: {
      orders: ordersFc,
      ordersHistory: dates.map((date, i) => ({ date, value: ordersSeries.values[i] })),
      items: itemsFc,
    },
    backtest: bt,
    learningCurve: lc,
    todayPlan,
    combo,
    stock,
    money,
    insights: [],
  };
  analysis.insights = ruleInsights(analysis, nameOf);
  return analysis;
}

/**
 * Stock to have on hand. Uses the upper end of the 80% forecast range so the
 * kitchen runs out at most about one day in ten, then multiplies by recipes.
 */
function stockPlan(today: string, future: string[], itemsFc: { itemId: string; name: string; points: Forecast[] }[]): StockPlan {
  const todayIn = future[0] === today;
  const tomorrow = future[todayIn ? 1 : 0];
  const week = future.slice(todayIn ? 1 : 0, (todayIn ? 1 : 0) + 6);
  const at = (pts: Forecast[], d: string | undefined) => (d ? pts.find((p) => p.date === d)?.high ?? 0 : 0);
  const items = itemsFc.map((f) => ({
    itemId: f.itemId,
    name: f.name,
    today: Math.ceil(todayIn ? at(f.points, today) : 0),
    tomorrow: Math.ceil(at(f.points, tomorrow)),
    week: Math.ceil(week.reduce((a, d) => a + at(f.points, d), 0)),
  }));
  const ing = new Map<string, { today: number; tomorrow: number; week: number }>();
  for (const it of items)
    for (const [name, per] of Object.entries(RECIPES[it.itemId] ?? {})) {
      const cur = ing.get(name) ?? { today: 0, tomorrow: 0, week: 0 };
      cur.today += it.today * per;
      cur.tomorrow += it.tomorrow * per;
      cur.week += it.week * per;
      ing.set(name, cur);
    }
  const round = (v: number, unit: string) => (unit === 'kg' || unit === 'L' ? Math.ceil(v * 10) / 10 : Math.ceil(v));
  return {
    days: { today: todayIn ? today : null, tomorrow, week },
    items: items.sort((a, b) => b.tomorrow - a.tomorrow),
    ingredients: [...ing]
      .map(([name, v]) => {
        const unit = UNITS[name] ?? '';
        return { name, unit, today: round(v.today, unit), tomorrow: round(v.tomorrow, unit), week: round(v.week, unit) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function moneyHistory(db: Db, today: string, menu: MenuRow[]): Promise<Money> {
  const rows = await db.query<{ d: string; revenue: number; cost: number; discount: number }>(
    `SELECT o.service_date AS d, SUM(o.total)::int AS revenue, SUM(o.discount)::int AS discount,
            COALESCE(SUM(c.cost), 0)::int AS cost
       FROM orders o
       LEFT JOIN (SELECT oi.order_id, SUM(oi.qty * COALESCE(m.cost, 0)) AS cost
                    FROM order_items oi JOIN menu_items m ON m.id = oi.item_id GROUP BY 1) c ON c.order_id = o.id
      WHERE o.status <> 'cancelled' AND o.service_date < $1
      GROUP BY 1 ORDER BY 1`,
    [today],
  );
  const per = await db.query<{ item_id: string; units: number; revenue: number }>(
    `SELECT oi.item_id, SUM(oi.qty)::int AS units, SUM(oi.qty * oi.unit_price)::int AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status <> 'cancelled' AND o.service_date < $1
      GROUP BY 1`,
    [today],
  );
  const days = rows.map((r) => ({ date: r.d, revenue: r.revenue, cost: r.cost, profit: r.revenue - r.cost, discount: r.discount }));
  const items = menu
    .map((m) => {
      const p = per.find((x) => x.item_id === m.id);
      const units = p?.units ?? 0;
      const revenue = p?.revenue ?? 0;
      const foodCost = units * m.cost;
      return { itemId: m.id, name: m.name, price: m.price, cost: m.cost, units, revenue, foodCost, profit: revenue - foodCost, margin: revenue ? (revenue - foodCost) / revenue : 0 };
    })
    .sort((a, b) => b.profit - a.profit);
  const rev = days.reduce((a, d) => a + d.revenue, 0);
  const prof = days.reduce((a, d) => a + d.profit, 0);
  return { days, items, avgProfitPerDay: days.length ? prof / days.length : 0, marginPct: rev ? prof / rev : 0 };
}

async function comboOfDay(db: Db, today: string, menu: MenuRow[]): Promise<Combo | null> {
  const dow = dowOf(today);
  const pairs = await db.query<{ x: string; y: string; n: number }>(
    `SELECT a.item_id AS x, b.item_id AS y, COUNT(*)::int AS n
       FROM order_items a
       JOIN order_items b ON a.order_id = b.order_id AND a.item_id < b.item_id
       JOIN orders o ON o.id = a.order_id
      WHERE o.service_date < $1 AND o.status <> 'cancelled'
        AND EXTRACT(DOW FROM o.service_date::date) = $2
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`,
    [today, dow],
  );
  const singles = await db.query<{ item_id: string; n: number }>(
    `SELECT oi.item_id, COUNT(DISTINCT oi.order_id)::int AS n
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.service_date < $1 AND o.status <> 'cancelled'
        AND EXTRACT(DOW FROM o.service_date::date) = $2
      GROUP BY 1`,
    [today, dow],
  );
  const count = new Map(singles.map((s) => [s.item_id, s.n]));
  // Prefer a meal + something: pairs with a main dish score higher.
  const scored = pairs
    .map((p) => {
      const ix = menu.find((m) => m.id === p.x);
      const iy = menu.find((m) => m.id === p.y);
      if (!ix || !iy) return null;
      // The pricier item is what people came for; the cheaper one is the add-on
      // (samosa + chai, not chai + samosa).
      const [main, side] = ix.price >= iy.price ? [ix, iy] : [iy, ix];
      const attach = p.n / (count.get(main.id) ?? 1);
      const value = p.n * (main.category === 'Meals' ? 1.4 : 1);
      return { main, side, attach, n: p.n, value };
    })
    .filter(Boolean)
    .sort((a, b) => b!.value - a!.value);
  const best = scored[0];
  if (!best) return null;
  const fullPrice = best.main.price + best.side.price;
  const price = Math.floor((fullPrice * 0.9) / 5) * 5;
  return {
    items: [best.main, best.side].map(({ id, name, price }) => ({ id, name, price })),
    price,
    fullPrice,
    reason: `${Math.round(best.attach * 100)}% of ${best.main.name} orders on ${DOW_NAMES[dow]}s already add ${best.side.name}.`,
  };
}

function ruleInsights(a: Analysis, nameOf: (id: string) => string): string[] {
  const out: string[] = [];
  const p = a.peakSlots[0];
  if (p) {
    const share = (a.peakSlots.reduce((s, x) => s + x.avg, 0) / Math.max(1, a.avgOrdersPerDay)) * 100;
    out.push(
      `The three busiest slots (${a.peakSlots.map((s) => s.label).join(', ')}) take ${share.toFixed(0)}% of the day's orders; ${p.label} alone averages ${p.avg.toFixed(0)} orders.`,
    );
  }
  if (a.queue.maxWaitMin > 1)
    out.push(
      `With one counter serving 2 orders a minute, the queue peaks at about ${a.queue.maxWaitMin.toFixed(0)} minutes around ${slotLabel(a.queue.worstSlot)}. Capping each slot moves that wait into quieter slots.`,
    );
  const fri = a.topByDow.Fri?.[0];
  const mon = a.topByDow.Mon?.[0];
  if (fri && mon && fri.itemId !== mon.itemId)
    out.push(`The top seller changes by weekday: ${mon.name} leads on Mondays, ${fri.name} on Fridays. Prep should follow the day, not a fixed list.`);
  if (a.backtest) {
    const gain = (1 - a.backtest.model / a.backtest.seasonalNaive) * 100;
    out.push(
      `On the held-out last week, the forecast missed by ${(a.backtest.model * 100).toFixed(1)}% (WAPE) against ${(a.backtest.seasonalNaive * 100).toFixed(1)}% for "same as last week"${gain > 0 ? `, ${gain.toFixed(0)}% better` : ''}.`,
    );
  }
  const lc = a.learningCurve;
  if (lc.length >= 2)
    out.push(
      `More history helps: training on ${lc[0].trainDays} days misses by ${(lc[0].wape * 100).toFixed(1)}%, on ${lc[lc.length - 1].trainDays} days by ${(lc[lc.length - 1].wape * 100).toFixed(1)}%. Every day of app orders is added to the training data.`,
    );
  void nameOf;
  return out;
}
