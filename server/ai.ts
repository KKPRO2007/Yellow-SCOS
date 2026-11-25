import { z } from 'zod';
import type { Analysis } from './analytics.js';
import type { SlotView } from './ordering.js';

// The LLM reads numbers the code already computed (stats, ML forecast,
// backtest, stock plan, money, live slot fill) and turns them into a plan for
// the shopkeeper. It never invents data.
//
// Provider chain, first one configured and working wins:
//   GEMINI_API_KEY  -> Google Gemini   (GEMINI_MODEL: comma list, default gemini-flash-latest,gemini-2.5-flash,...)
//   GROQ_API_KEY    -> Groq            (GROQ_MODEL,   default openai/gpt-oss-120b)
//   ANTHROPIC_API_KEY -> Claude        (CLAUDE_MODEL, default claude-opus-5-5)
//   otherwise       -> rule-based briefing, so the demo never breaks.

// Lenient on form (numbers -> text, long lists trimmed, role synonyms mapped),
// strict on substance (a headline and real findings/actions must be there).
const text = z.preprocess((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)), z.string());
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : v === undefined || v === null ? [] : [v]), z.array(item));
const who = z.preprocess((v) => {
  const s = String(v ?? '').toLowerCase();
  if (/student|customer|buyer/.test(s)) return 'students';
  if (/kitchen|cook|chef|staff/.test(s)) return 'kitchen';
  return 'shopkeeper';
}, z.enum(['kitchen', 'shopkeeper', 'students']));

const Briefing = z.object({
  headline: z.string().min(5),
  insights: list(z.object({ title: text, detail: text, metric: text }), 6).refine((a) => a.length > 0, 'no insights'),
  actions: list(z.object({ who, action: text, why: text }), 6).refine((a) => a.length > 0, 'no actions'),
  stock: list(z.object({ ingredient: text, buy: text, when: text, why: text }), 8),
  money: text,
  risks: list(text, 4),
});
type B = z.infer<typeof Briefing>;
export type BriefingT = B & { source: 'gemini' | 'groq' | 'claude' | 'rules'; model?: string; note?: string; at: string };

const SHAPE = `{
  "headline": "one sentence, the single most important thing today",
  "insights": [{"title": "...", "detail": "...", "metric": "a number from the data"}],   // 3-5
  "actions":  [{"who": "kitchen" | "shopkeeper" | "students", "action": "...", "why": "..."}], // 3-5
  "stock":    [{"ingredient": "...", "buy": "quantity with unit", "when": "today" | "tomorrow" | "this week", "why": "..."}], // 3-6, biggest first
  "money":    "one or two sentences on revenue, food cost, margin and which items earn the most",
  "risks":    ["up to 3 things that could go wrong"]
}`;

const SYSTEM =
  'You are the operations analyst for a college canteen with one counter and pre-booked 15-minute pickup slots. ' +
  'You get numbers already computed from past orders: an ML demand forecast per item with an 80% range, its backtest, ' +
  'a stock plan (raw ingredients needed today, tomorrow and for the coming week, from recipes x forecast upper range), ' +
  'money figures (revenue, food cost, profit, margin per item) and live slot bookings. ' +
  'Write a short, practical briefing for the shopkeeper. Every claim must cite a number from the data; never invent figures. ' +
  'Prices are Indian rupees. Reply with JSON only, exactly this shape:\n' +
  SHAPE;

let cached: { key: string; value: BriefingT } | null = null;

function compact(a: Analysis, slots: SlotView[]) {
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    today: a.today,
    weekday: a.todayPlan.dow,
    historyDays: a.days,
    avgOrdersPerDay: r(a.avgOrdersPerDay),
    peakSlots: a.peakSlots.map((p) => ({ slot: p.label, avgOrders: r(p.avg) })),
    oneCounterQueue: { maxWaitMin: r(a.queue.maxWaitMin), at: a.queue.worstSlot },
    topItemsToday: a.topByDow[a.todayPlan.dow] ?? [],
    forecastOrdersNextDays: a.forecast.orders.map((f) => ({ date: f.date, orders: Math.round(f.value), low: Math.round(f.low), high: Math.round(f.high) })),
    stockPlan: {
      days: a.stock.days,
      ingredients: a.stock.ingredients,
      itemsTomorrow: a.stock.items.slice(0, 8).map((i) => ({ item: i.name, units: i.tomorrow, week: i.week })),
    },
    backtestErrorPct: a.backtest && { model: r(a.backtest.model * 100), sameAsLastWeek: r(a.backtest.seasonalNaive * 100), movingAverage: r(a.backtest.movingAverage * 100) },
    learningCurve: a.learningCurve.map((p) => ({ trainDays: p.trainDays, errorPct: r(p.wape * 100) })),
    money: {
      avgRevenuePerDay: Math.round(a.avgRevenuePerDay),
      avgProfitPerDay: Math.round(a.money.avgProfitPerDay),
      marginPct: r(a.money.marginPct * 100),
      itemsByProfit: a.money.items.slice(0, 6).map((i) => ({ item: i.name, profit: i.profit, marginPct: r(i.margin * 100) })),
      lowestMargin: a.money.items.slice().sort((x, y) => x.margin - y.margin).slice(0, 2).map((i) => ({ item: i.name, marginPct: r(i.margin * 100) })),
    },
    comboOfDay: a.combo && { items: a.combo.items.map((i) => i.name), price: a.combo.price, reason: a.combo.reason },
    liveSlots: slots
      .filter((s) => s.booked > 0 || s.forecastOrders > 0)
      .map((s) => ({ slot: s.label, booked: s.booked, capacity: s.capacity, forecastDemand: s.forecastOrders, status: s.status })),
  };
}

export function aiProviders() {
  return [
    process.env.GEMINI_API_KEY && 'gemini',
    process.env.GROQ_API_KEY && 'groq',
    process.env.ANTHROPIC_API_KEY && 'claude',
  ].filter(Boolean) as string[];
}

export async function briefing(a: Analysis, slots: SlotView[], force = false): Promise<BriefingT> {
  const key = `${a.today}:${Math.floor(Date.now() / 600_000)}`;
  if (!force && cached?.key === key) return cached.value;
  const r = await llmJson(SYSTEM, `Today's data:\n${JSON.stringify(compact(a, slots))}`, Briefing);
  const value: BriefingT = r.value
    ? { ...r.value, source: r.source, model: r.model, note: r.note, at: new Date().toISOString() }
    : { ...rules(a, slots), source: 'rules', note: `${r.note} Showing the rule-based briefing.`, at: new Date().toISOString() };
  cached = { key, value };
  return value;
}

type Source = 'gemini' | 'groq' | 'claude';

/**
 * Ask every configured provider at once and keep the first reply that parses
 * into `schema`. A busy model (Gemini 503s at peak) then costs no latency.
 */
export async function llmJson<S extends z.ZodTypeAny>(
  system: string,
  user: string,
  schema: S,
): Promise<{ value: z.infer<S>; source: Source; model: string; note?: string } | { value: null; note: string }> {
  if (process.env.AI_DISABLED === 'true') return { value: null, note: 'AI is turned off (AI_DISABLED=true).' };
  const chain: [Source, () => Promise<{ text: string; model: string }>][] = [];
  if (process.env.GEMINI_API_KEY) chain.push(['gemini', () => gemini(system, user)]);
  if (process.env.GROQ_API_KEY) chain.push(['groq', () => groq(system, user)]);
  if (process.env.ANTHROPIC_API_KEY) chain.push(['claude', () => claude(system, user)]);
  if (!chain.length) return { value: null, note: 'No LLM key set (GEMINI_API_KEY or GROQ_API_KEY).' };
  const notes: string[] = [];
  try {
    return await Promise.any(
      chain.map(async ([name, call]) => {
        try {
          const { text, model } = await withTimeout(call(), Number(process.env.LLM_TIMEOUT_MS ?? 20_000) + 10_000);
          const value = schema.parse(JSON.parse(stripFences(text)));
          return { value, source: name, model, note: notes.join(' ') || undefined };
        } catch (err) {
          notes.push(`${name} failed: ${describe(err)}.`);
          throw err;
        }
      }),
    );
  } catch {
    return { value: null, note: notes.join(' ') };
  }
}

function stripFences(t: string) {
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (m ? m[1] : t).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

function describe(err: unknown) {
  if (err instanceof z.ZodError) return `reply did not match the expected shape (${err.issues[0]?.path.join('.')}: ${err.issues[0]?.message})`;
  if (err instanceof SyntaxError) return 'reply was not valid JSON';
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 20_000)) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 160);
    try {
      const j = JSON.parse(text);
      msg = j.error?.message ?? j.message ?? msg;
    } catch {
      /* keep raw text */
    }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return JSON.parse(text);
}

// Busy models (503/429) are common on free tiers: retry once, then try the next model.
async function gemini(system: string, user: string) {
  const models = (process.env.GEMINI_MODEL ?? 'gemini-flash-latest,gemini-2.5-flash,gemini-flash-lite-latest').split(',').map((m) => m.trim());
  let last: unknown;
  for (const model of models)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await geminiOnce(system, user, model);
      } catch (err) {
        last = err;
        const busy = /HTTP (503|429|500)/.test(String((err as Error).message));
        if (!busy) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
  throw last;
}

async function geminiOnce(system: string, user: string, model: string) {
  const j = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': process.env.GEMINI_API_KEY! },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
        // Keep it quick: this is a summary of numbers already computed, not a puzzle.
        thinkingConfig: model.startsWith('gemini-2.5') ? { thinkingBudget: model.includes('pro') ? 128 : 0 } : { thinkingLevel: 'low' },
      },
    },
  );
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  if (!text) throw new Error(`empty reply (${j.candidates?.[0]?.finishReason ?? j.promptFeedback?.blockReason ?? 'unknown'})`);
  return { text, model: j.modelVersion ?? model };
}

async function groq(system: string, user: string) {
  const model = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
  const j = await postJson(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    {
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  );
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty reply');
  return { text, model: j.model ?? model };
}

async function claude(system: string, user: string) {
  const model = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
  const j = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] },
  );
  const text = (j.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
  if (!text) throw new Error(`empty reply (${j.stop_reason})`);
  return { text, model: j.model ?? model };
}

function rules(a: Analysis, slots: SlotView[]): B {
  const top = a.topByDow[a.todayPlan.dow] ?? [];
  const peak = a.peakSlots[0];
  const fc = a.forecast.orders.find((f) => f.date === a.today) ?? a.forecast.orders[0];
  const overflow = slots.filter((s) => s.forecastOrders > s.capacity).sort((x, y) => y.forecastOrders - y.capacity - (x.forecastOrders - x.capacity));
  const quiet = slots.filter((s) => s.quiet).map((s) => s.label);
  const items = [...a.stock.items].sort((x, y) => y.today - x.today);
  const best = a.money.items[0];
  const worst = [...a.money.items].sort((x, y) => x.margin - y.margin)[0];
  const ing = [...a.stock.ingredients].sort((x, y) => y.week - x.week);
  return {
    headline: fc
      ? `Expect about ${Math.round(fc.value)} orders ${fc.date === a.today ? 'today' : `on ${fc.date}`} (${Math.round(fc.low)}–${Math.round(fc.high)}); ${peak ? `${peak.label} is the crunch` : 'no clear peak'}.`
      : 'Not enough history yet for a forecast.',
    insights: [
      ...(peak ? [{ title: 'Lunch peak', detail: `${peak.label} averages ${peak.avg.toFixed(0)} orders against a counter that serves ${a.queue.counterPerSlot} per slot.`, metric: `${peak.avg.toFixed(0)} orders` }] : []),
      ...(top[0] ? [{ title: `${a.todayPlan.dow} best seller`, detail: `${top[0].name} averages ${top[0].avgQty.toFixed(0)} a day on ${a.todayPlan.dow}s.`, metric: `${top[0].avgQty.toFixed(0)} units` }] : []),
      ...(a.backtest ? [{ title: 'Forecast accuracy', detail: `On the held-out week the model was off by ${(a.backtest.model * 100).toFixed(1)}% vs ${(a.backtest.seasonalNaive * 100).toFixed(1)}% for "same as last week".`, metric: `${(a.backtest.model * 100).toFixed(1)}% error` }] : []),
      ...(best ? [{ title: 'Top earner', detail: `${best.name} made ₹${best.profit.toLocaleString('en-IN')} profit over ${a.days} days at a ${(best.margin * 100).toFixed(0)}% margin.`, metric: `₹${best.profit.toLocaleString('en-IN')}` }] : []),
    ],
    actions: [
      ...items.slice(0, 2).map((i) => ({ who: 'kitchen' as const, action: `Prep up to ${i.today} ${i.name} today, most of it before 12:45.`, why: 'Upper end of the item forecast.' })),
      ...(overflow[0] ? [{ who: 'shopkeeper' as const, action: `Keep ${overflow[0].label} capped and promote ${quiet.slice(0, 2).join(' / ') || 'later slots'}.`, why: `Forecast demand ${overflow[0].forecastOrders} vs capacity ${overflow[0].capacity}.` }] : []),
      ...(quiet.length ? [{ who: 'students' as const, action: `Pick ${quiet[0]} for no wait.`, why: 'One of the least booked slots right now.' }] : []),
    ],
    stock: ing.slice(0, 5).map((g) => ({ ingredient: g.name, buy: `${g.week} ${g.unit}`, when: 'this week', why: `${g.tomorrow} ${g.unit} tomorrow alone, from the item forecast x recipes.` })),
    money: best
      ? `Average ₹${Math.round(a.avgRevenuePerDay).toLocaleString('en-IN')} revenue and ₹${Math.round(a.money.avgProfitPerDay).toLocaleString('en-IN')} profit a day (${(a.money.marginPct * 100).toFixed(0)}% margin). ${best.name} earns the most${worst ? `; ${worst.name} has the thinnest margin (${(worst.margin * 100).toFixed(0)}%)` : ''}.`
      : '',
    risks: [
      ...(fc && fc.high > a.avgOrdersPerDay * 1.15 ? ['Demand could run well above average; watch stock of the top items.'] : []),
      ...(overflow.length > 2 ? [`${overflow.length} slots are forecast above capacity; students will be pushed to later slots.`] : []),
    ],
  };
}

// ---------------------------------------------------------------- purchase order
const PurchaseNote = z.object({
  summary: z.string().min(5),
  urgent: list(z.object({ ingredient: text, why: text }), 6),
  message: z.string().min(10),
});
export type PurchaseNoteT = z.infer<typeof PurchaseNote> & { source: Source | 'rules'; model?: string; note?: string };

const PO_SYSTEM =
  'You are the purchasing assistant for a college canteen. You get a purchase list the code already computed ' +
  '(quantities = tomorrow\'s upper demand forecast + 15% minus stock on hand, wholesale prices in rupees) and the live ' +
  'stock levels. Never change quantities or prices. Write: a one-line summary for the shopkeeper; which items are urgent ' +
  '(already low or out today) and why; and a short, polite WhatsApp message to the supplier listing every line with ' +
  'quantity and unit, asking for delivery before 9:30 am. Reply with JSON only: ' +
  '{"summary": "...", "urgent": [{"ingredient": "...", "why": "..."}], "message": "..."}';

export async function purchaseNote(
  po: { lines: { ingredient: string; unit: string; qty: number; total: number; onHand: number }[]; total: number; forDate: string },
  stock: { name: string; status: string; onHand: number; unit: string }[],
): Promise<PurchaseNoteT> {
  const low = stock.filter((x) => x.status !== 'ok');
  const r = await llmJson(PO_SYSTEM, JSON.stringify({ deliverFor: po.forDate, lines: po.lines, totalINR: po.total, lowOrOutNow: low }), PurchaseNote);
  if (r.value) return { ...r.value, source: r.source, model: r.model, note: r.note };
  const fmt = (l: { ingredient: string; qty: number; unit: string }) => `${l.ingredient}: ${l.qty} ${l.unit}`;
  return {
    source: 'rules',
    note: `${r.note} Showing the rule-based draft.`,
    summary: `${po.lines.length} items to buy for ${po.forDate}, about ₹${po.total.toLocaleString('en-IN')}.`,
    urgent: low.map((x) => ({ ingredient: x.name, why: x.status === 'out' ? 'Out of stock now.' : `Only ${x.onHand} ${x.unit} left.` })),
    message: `Hello, please deliver before 9:30 am on ${po.forDate}:\n${po.lines.map(fmt).join('\n')}\nThank you, Yellow Canteen.`,
  };
}
