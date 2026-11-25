import { useState, type FormEvent } from 'react';
import { api, rupees, useLive, type Combo } from './api';
import { BarChart, LineChart, RankBars, TableToggle } from './charts';

interface Fc {
  date: string;
  dow: number;
  value: number;
  low: number;
  high: number;
}
interface Insights {
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
    orders: Fc[];
    ordersHistory: { date: string; value: number }[];
    items: { itemId: string; name: string; points: Fc[] }[];
  };
  backtest: { holdoutDays: number; model: number; seasonalNaive: number; movingAverage: number } | null;
  learningCurve: { trainDays: number; wape: number }[];
  todayPlan: { dow: string; ordersForecast: number };
  combo: Combo | null;
  stock: {
    days: { today: string | null; tomorrow: string; week: string[] };
    items: { itemId: string; name: string; today: number; tomorrow: number; week: number }[];
    ingredients: { name: string; unit: string; today: number; tomorrow: number; week: number }[];
  };
  money: {
    days: { date: string; revenue: number; cost: number; profit: number; discount: number }[];
    items: { itemId: string; name: string; price: number; cost: number; units: number; revenue: number; foodCost: number; profit: number; margin: number }[];
    avgProfitPerDay: number;
    marginPct: number;
  };
  insights: string[];
  live: { orders: number; revenue: number; cost: number; profit: number; discount: number; ready: number; collected: number; cancelled: number; paidOnline: number; dueAtCounter: number };
}
interface Briefing {
  headline: string;
  insights: { title: string; detail: string; metric: string }[];
  actions: { who: string; action: string; why: string }[];
  stock: { ingredient: string; buy: string; when: string; why: string }[];
  money: string;
  risks: string[];
  source: 'gemini' | 'groq' | 'claude' | 'rules';
  model?: string;
  note?: string;
  at: string;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const short = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`;
};
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const SOURCE: Record<Briefing['source'], string> = { gemini: 'Google Gemini', groq: 'Groq', claude: 'Claude', rules: 'rules' };

// The briefing is shared by Overview and Stock, so it lives above them.
let briefingCache: Briefing | null = null;

export function Admin({ section }: { section: 'overview' | 'stock' | 'money' | 'settings' }) {
  const ins = useLive<Insights>('/insights', ['orders'], 60_000);
  if (section === 'settings')
    return (
      <main className="page stack">
        <div className="page-title">
          <h1>Settings</h1>
        </div>
        <div className="grid grid-2">
          <SettingsCard onReset={ins.reload} />
          <StaffCard />
        </div>
      </main>
    );
  if (!ins.data)
    return <main className="page">{ins.error ? <div className="notice bad">{ins.error}</div> : <p className="muted">Crunching past orders…</p>}</main>;
  const a = ins.data;
  return (
    <main className="page stack">
      {section === 'overview' && <Overview a={a} />}
      {section === 'stock' && <Stock a={a} />}
      {section === 'money' && <MoneyView a={a} reload={ins.reload} />}
    </main>
  );
}

function useTables() {
  const [tables, setTables] = useState<Record<string, boolean>>({});
  return (k: string) => ({ on: Boolean(tables[k]), set: (v: boolean) => setTables((s) => ({ ...s, [k]: v })) });
}

// ---------------------------------------------------------------- overview
function Overview({ a }: { a: Insights }) {
  const [dow, setDow] = useState<string | null>(null);
  const t = useTables();
  const day = dow ?? (DAYS.includes(a.todayPlan.dow) ? a.todayPlan.dow : 'Mon');
  const fcToday = a.forecast.orders.find((f) => f.date === a.today);
  const peakKeys = new Set(a.peakSlots.map((p) => p.slot));
  return (
    <>
      <div className="page-title">
        <h1>Overview</h1>
        <p className="small muted">
          {a.days} days of orders ({short(a.firstDay)} – {short(a.lastDay)}), {a.totalOrders.toLocaleString('en-IN')} orders. Today is {a.todayPlan.dow}.
        </p>
      </div>
      <div className="kpis">
        <Kpi v={String(a.live.orders)} l="Orders booked today" sub={`${a.live.collected} collected · ${a.live.ready} ready`} />
        <Kpi v={rupees(a.live.revenue)} l="Revenue today" sub={`profit ${rupees(a.live.profit)}`} />
        <Kpi v={fcToday ? String(Math.round(fcToday.value)) : '—'} l="Forecast orders today" sub={fcToday ? `80% range ${Math.round(fcToday.low)}–${Math.round(fcToday.high)}` : 'canteen closed today'} />
        <Kpi v={`${a.queue.maxWaitMin.toFixed(0)} min`} l="Peak queue without slots" sub={`one counter, around ${a.slotAvg.find((s) => s.slot === a.queue.worstSlot)?.label.split('–')[0] ?? ''}`} />
      </div>

      <BriefingCard />

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Orders per 15-minute slot</h2>
              <span className="small faint">daily average · darker = 3 busiest</span>
            </div>
            <TableToggle {...t('slots')} />
          </div>
          <BarChart
            showTable={t('slots').on}
            valueName="Avg orders"
            labelEvery={2}
            refLine={{ value: a.queue.counterPerSlot, label: `counter serves ${a.queue.counterPerSlot}` }}
            data={a.slotAvg.map((s) => ({
              key: s.slot,
              label: s.label.split('–')[0].replace(/ [ap]m/, ''),
              name: s.label,
              value: s.avg,
              highlight: peakKeys.has(s.slot),
              tip: `${s.label}: ${s.avg.toFixed(1)} orders/day`,
            }))}
          />
          <p className="small muted" style={{ marginTop: 8 }}>
            Peak: <strong>{a.peakSlots.map((p) => `${p.label} (${p.avg.toFixed(0)})`).join(', ')}</strong>.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Top 5 items by weekday</h2>
              <span className="small faint">average units sold per day</span>
            </div>
            <div className="tabs" role="tablist">
              {DAYS.filter((d) => a.topByDow[d]).map((d) => (
                <button key={d} role="tab" aria-selected={day === d} onClick={() => setDow(d)}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <RankBars rows={(a.topByDow[day] ?? []).map((i) => ({ key: i.itemId, label: i.name, value: i.avgQty }))} />
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>What the data says</h2>
        </div>
        <ul className="stack" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
          {a.insights.map((s) => (
            <li key={s}>{s}</li>
          ))}
          {a.combo && (
            <li>
              Combo of the day: {a.combo.items.map((i) => i.name).join(' + ')} at {rupees(a.combo.price)} (was {rupees(a.combo.fullPrice)}). {a.combo.reason}
            </li>
          )}
        </ul>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- stock & forecast
function Stock({ a }: { a: Insights }) {
  const t = useTables();
  const [range, setRange] = useState<'today' | 'tomorrow' | 'week'>(a.stock.days.today ? 'today' : 'tomorrow');
  const hist = a.forecast.ordersHistory.slice(-18);
  const label = { today: 'Today', tomorrow: `Tomorrow (${short(a.stock.days.tomorrow)})`, week: `Next ${a.stock.days.week.length} days` };
  return (
    <>
      <div className="page-title stock">
        <h1>Stock & forecast</h1>
        <p className="small muted">
          An ML model (ridge regression on weekday, trend and last week) forecasts each item from past orders; recipes turn that into raw stock. Quantities use the
          upper end of the 80% range, so you run short at most about one day in ten.
        </p>
      </div>

      <div className="grid grid-2">
        <LiveStock />
        <PurchaseOrder />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Stock to buy</h2>
              <span className="small faint">raw ingredients, from forecast × recipes</span>
            </div>
            <div className="tabs" role="tablist">
              {(a.stock.days.today ? (['today', 'tomorrow', 'week'] as const) : (['tomorrow', 'week'] as const)).map((r) => (
                <button key={r} role="tab" aria-selected={range === r} onClick={() => setRange(r)}>
                  {r === 'week' ? 'Week' : r === 'today' ? 'Today' : 'Tomorrow'}
                </button>
              ))}
            </div>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th className="r">{label[range]}</th>
              </tr>
            </thead>
            <tbody>
              {[...a.stock.ingredients]
                .sort((x, y) => y[range] - x[range])
                .map((g) => (
                  <tr key={g.name}>
                    <td>{g.name}</td>
                    <td className="r">
                      <strong>{g[range]}</strong> <span className="faint">{g.unit}</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Items to prepare</h2>
              <span className="small faint">units, upper forecast</span>
            </div>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                {a.stock.days.today && <th className="r">Today</th>}
                <th className="r">Tomorrow</th>
                <th className="r">Week</th>
              </tr>
            </thead>
            <tbody>
              {a.stock.items.map((i) => (
                <tr key={i.itemId}>
                  <td>{i.name}</td>
                  {a.stock.days.today && <td className="r">{i.today}</td>}
                  <td className="r">
                    <strong>{i.tomorrow}</strong>
                  </td>
                  <td className="r">{i.week}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <BriefingCard stockOnly />

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Daily orders and forecast</h2>
              <span className="small faint">solid = actual · dashed = forecast · band = 80% range</span>
            </div>
            <TableToggle {...t('fc')} />
          </div>
          <LineChart
            showTable={t('fc').on}
            valueName="Orders"
            labelEvery={3}
            data={[
              ...hist.map((h) => ({ key: h.date, label: short(h.date), value: h.value })),
              ...a.forecast.orders.map((f) => ({ key: f.date, label: short(f.date), value: f.value, low: f.low, high: f.high, forecast: true })),
            ]}
          />
        </section>

        <section className="card stack">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <div>
              <h2>How good is the forecast?</h2>
              <span className="small faint">held-out last {a.backtest?.holdoutDays ?? 6} days · error (WAPE), lower is better</span>
            </div>
          </div>
          {a.backtest ? (
            <table className="data">
              <tbody>
                <tr>
                  <td>
                    <strong>Our model</strong>
                  </td>
                  <td className="r">
                    <strong>{pct(a.backtest.model)}</strong>
                  </td>
                </tr>
                <tr>
                  <td>“Same as last week”</td>
                  <td className="r">{pct(a.backtest.seasonalNaive)}</td>
                </tr>
                <tr>
                  <td>“Average of last week”</td>
                  <td className="r">{pct(a.backtest.movingAverage)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted small">Needs at least 18 days of history.</p>
          )}
          <div className="card-head" style={{ marginBottom: 0 }}>
            <div>
              <h3>More data, better forecast</h3>
              <span className="small faint">error on the same week vs days of training data · every app order is new training data</span>
            </div>
            <TableToggle {...t('lc')} />
          </div>
          <LineChart
            showTable={t('lc').on}
            height={170}
            valueName="Error"
            format={(v) => `${(v * 100).toFixed(0)}%`}
            data={a.learningCurve.map((p) => ({ key: String(p.trainDays), label: `${p.trainDays}d`, value: p.wape }))}
          />
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- money
function MoneyView({ a, reload }: { a: Insights; reload: () => void }) {
  const t = useTables();
  const m = a.money;
  const last = m.days.slice(-24);
  const total = m.days.reduce((s, d) => ({ revenue: s.revenue + d.revenue, cost: s.cost + d.cost, profit: s.profit + d.profit, discount: s.discount + d.discount }), {
    revenue: 0,
    cost: 0,
    profit: 0,
    discount: 0,
  });
  return (
    <>
      <div className="page-title money">
        <h1>Money</h1>
        <p className="small muted">Revenue is what students paid (after combo discounts). Food cost is units sold × each item’s cost, which you can edit below.</p>
      </div>
      <span className="section-label">Today so far</span>
      <div className="kpis">
        <Kpi v={rupees(a.live.revenue)} l="Revenue" sub={`${a.live.orders} orders`} />
        <Kpi v={rupees(a.live.cost)} l="Food cost" />
        <Kpi v={rupees(a.live.profit)} l="Gross profit" sub={a.live.revenue ? `${((a.live.profit / a.live.revenue) * 100).toFixed(0)}% margin` : ''} />
        <Kpi v={rupees(a.live.discount)} l="Combo discounts given" sub={`${a.live.cancelled} cancelled`} />
      </div>
      <div className="kpis">
        <Kpi v={rupees(a.live.paidOnline ?? 0)} l="Paid online (UPI)" sub="already in the bank" />
        <Kpi v={rupees(a.live.dueAtCounter ?? 0)} l="Still to collect" sub="cash/UPI at the counter" />
      </div>
      <span className="section-label">Last {m.days.length} days</span>
      <div className="kpis">
        <Kpi v={rupees(total.revenue)} l="Revenue" sub={`avg ${rupees(Math.round(a.avgRevenuePerDay))}/day`} />
        <Kpi v={rupees(total.cost)} l="Food cost" />
        <Kpi v={rupees(total.profit)} l="Gross profit" sub={`avg ${rupees(Math.round(m.avgProfitPerDay))}/day`} />
        <Kpi v={`${(m.marginPct * 100).toFixed(1)}%`} l="Gross margin" />
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Gross profit per day</h2>
            <span className="small faint">hover a bar for revenue and cost</span>
          </div>
          <TableToggle {...t('profit')} />
        </div>
        <BarChart
          showTable={t('profit').on}
          valueName="Profit (₹)"
          labelEvery={3}
          format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))}
          data={last.map((d) => ({
            key: d.date,
            label: short(d.date),
            name: d.date,
            value: d.profit,
            tip: `${short(d.date)}: profit ${rupees(d.profit)} · revenue ${rupees(d.revenue)} · cost ${rupees(d.cost)}`,
          }))}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Per item</h2>
            <span className="small faint">last {m.days.length} days · edit cost to update margins</span>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">Price</th>
                <th className="r">Cost / unit</th>
                <th className="r">Units</th>
                <th className="r">Revenue</th>
                <th className="r">Profit</th>
                <th className="r">Margin</th>
              </tr>
            </thead>
            <tbody>
              {m.items.map((i) => (
                <tr key={i.itemId}>
                  <td>{i.name}</td>
                  <td className="r">{rupees(i.price)}</td>
                  <td className="r">
                    <CostInput id={i.itemId} cost={i.cost} onSaved={reload} />
                  </td>
                  <td className="r">{i.units.toLocaleString('en-IN')}</td>
                  <td className="r">{rupees(i.revenue)}</td>
                  <td className="r">
                    <strong>{rupees(i.profit)}</strong>
                  </td>
                  <td className="r">{(i.margin * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function CostInput({ id, cost, onSaved }: { id: string; cost: number; onSaved: () => void }) {
  const [v, setV] = useState(String(cost));
  const [state, setState] = useState<'idle' | 'saving' | 'err'>('idle');
  const save = async () => {
    if (Number(v) === cost) return;
    setState('saving');
    try {
      await api(`/menu/${id}`, { method: 'PATCH', body: { cost: Number(v) } });
      setState('idle');
      onSaved();
    } catch {
      setState('err');
    }
  };
  return (
    <input
      className="input num"
      style={{ width: 72, minHeight: 30, padding: '2px 8px', textAlign: 'right', borderColor: state === 'err' ? 'var(--bad)' : undefined }}
      type="number"
      min={0}
      value={v}
      aria-label="Cost per unit in rupees"
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Kpi({ v, l, sub }: { v: string; l: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="l">{l}</div>
      <div className="v">{v}</div>
      {sub && <div className="small faint">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- LLM briefing
function BriefingCard({ stockOnly = false }: { stockOnly?: boolean }) {
  const [b, setB] = useState<Briefing | null>(briefingCache);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function load(refresh: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<Briefing>('/ai/briefing', { body: { refresh } });
      briefingCache = r;
      setB(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const by = b ? (b.source === 'rules' ? 'Rule-based (no LLM reachable)' : `Written by ${SOURCE[b.source]} · ${b.model}`) : '';
  return (
    <section className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>{stockOnly ? 'AI stock advice' : 'AI briefing for today'}</h2>
          <span className="small faint">{b ? by : 'An LLM reads the computed numbers (forecast, stock, money, live slots) and writes the plan'}</span>
        </div>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => load(Boolean(b))}>
          {busy ? 'Thinking…' : b ? 'Refresh' : 'Generate'}
        </button>
      </div>
      {err && <div className="notice bad small">{err}</div>}
      {b?.note && <div className="small faint">{b.note}</div>}
      {b && stockOnly && (
        <table className="data">
          <thead>
            <tr>
              <th>Ingredient</th>
              <th>Buy</th>
              <th>When</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {b.stock.map((s) => (
              <tr key={s.ingredient + s.when}>
                <td>
                  <strong>{s.ingredient}</strong>
                </td>
                <td>{s.buy}</td>
                <td>{s.when}</td>
                <td className="muted">{s.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {b && !stockOnly && (
        <>
          <p style={{ fontSize: 16, fontWeight: 600 }}>{b.headline}</p>
          <div className="grid grid-2">
            <div className="stack" style={{ gap: 8 }}>
              <span className="section-label">Findings</span>
              {b.insights.map((i) => (
                <div key={i.title}>
                  <div className="row between">
                    <strong>{i.title}</strong>
                    <span className="pill plain num">{i.metric}</span>
                  </div>
                  <div className="small muted">{i.detail}</div>
                </div>
              ))}
              {b.money && (
                <>
                  <span className="section-label">Money</span>
                  <div className="small">{b.money}</div>
                </>
              )}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <span className="section-label">Do today</span>
              {b.actions.map((x) => (
                <div key={x.action}>
                  <span className="pill accent plain">{x.who}</span> {x.action}
                  <div className="small faint">{x.why}</div>
                </div>
              ))}
              {b.stock.length > 0 && (
                <>
                  <span className="section-label">Stock</span>
                  {b.stock.slice(0, 4).map((s) => (
                    <div key={s.ingredient + s.when} className="small">
                      <strong>{s.ingredient}</strong>: {s.buy} ({s.when})
                    </div>
                  ))}
                </>
              )}
              {b.risks.length > 0 && (
                <>
                  <span className="section-label">Watch out</span>
                  {b.risks.map((r) => (
                    <div key={r} className="small">
                      {r}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- settings
function SettingsCard({ onReset }: { onReset: () => void }) {
  const s = useLive<{ slotCapacity: number; closePastSlots: boolean }>('/admin/settings', ['settings']);
  const [cap, setCap] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!s.data) return <section className="card muted">Loading settings…</section>;
  const save = async (body: object) => {
    try {
      s.setData(await api('/admin/settings', { method: 'PATCH', body }));
      setMsg('Saved.');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const reset = async (seed: boolean) => {
    if (!confirm(seed ? "Delete today's orders and re-fill slots with sample bookings?" : "Delete all of today's orders and start empty?")) return;
    const r = await api<{ seeded: number }>('/admin/reset-today', { body: { seed } });
    setMsg(`Today reset${seed ? `, ${r.seeded} sample bookings added` : ''}.`);
    onReset();
  };
  return (
    <section className="card stack">
      <h2>Slots</h2>
      <form
        className="row"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save({ slotCapacity: Number(cap || s.data!.slotCapacity) });
        }}
      >
        <label className="field" style={{ flex: 1 }}>
          Orders per 15-minute slot (now {s.data.slotCapacity})
          <input className="input" type="number" min={1} max={500} placeholder={String(s.data.slotCapacity)} value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <button className="btn" style={{ alignSelf: 'flex-end' }}>
          Save
        </button>
      </form>
      <div className="toggle-row">
        <span>
          Close slots once their time has passed
          <div className="small faint">Leave off for demos outside canteen hours.</div>
        </span>
        <button className="switch" role="switch" aria-checked={s.data.closePastSlots} onClick={() => save({ closePastSlots: !s.data!.closePastSlots })} />
      </div>
      <div className="row wrap">
        <button className="btn btn-sm" onClick={() => reset(true)}>
          Reset today with sample bookings
        </button>
        <button className="btn btn-sm" onClick={() => reset(false)}>
          Reset today empty
        </button>
      </div>
      {msg && <span className="small muted">{msg}</span>}
    </section>
  );
}

function StaffCard() {
  const staff = useLive<{ id: number; name: string; email: string; role: string }[]>('/admin/staff', []);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="card stack">
      <h2>Staff accounts</h2>
      <table className="data">
        <tbody>
          {(staff.data ?? []).map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="muted">{u.email}</td>
              <td className="r">
                <span className="pill plain">{u.role === 'admin' ? 'shopkeeper' : 'kitchen'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/admin/staff', { body: f });
            setF({ name: '', email: '', password: '' });
            setMsg('Kitchen account added.');
            staff.reload();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <span className="section-label">Add kitchen staff</span>
        <div className="row wrap">
          <input className="input" style={{ flex: '1 1 120px' }} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <input className="input" style={{ flex: '1 1 160px' }} type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <input className="input" style={{ flex: '1 1 120px' }} type="password" placeholder="Password" minLength={6} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          <button className="btn">Add</button>
        </div>
        {msg && <span className="small muted">{msg}</span>}
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- live stock & purchase order
interface StockRow {
  name: string;
  unit: string;
  onHand: number;
  reorderLevel: number;
  price: number;
  status: 'ok' | 'low' | 'out';
}

function LiveStock() {
  const st = useLive<{ stock: StockRow[] }>('/stock', ['stock', 'menu'], 30_000);
  const [busy, setBusy] = useState(false);
  const rows = [...(st.data?.stock ?? [])].sort((x, y) => (x.status === y.status ? x.name.localeCompare(y.name) : x.status === 'out' ? -1 : y.status === 'out' ? 1 : x.status === 'low' ? -1 : 1));
  const restockAll = async () => {
    if (!confirm('Log the morning delivery? Every ingredient is reset to today\'s forecast need + 15%.')) return;
    setBusy(true);
    st.setData(await api('/stock/restock', { body: { all: true } }).catch(() => st.data));
    setBusy(false);
  };
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Live stock</h2>
          <span className="small faint">goes down with every order, back up on cancels</span>
        </div>
        <button className="btn btn-sm" disabled={busy} onClick={restockAll}>
          Morning delivery
        </button>
      </div>
      {!rows.length && <p className="small muted">No stock tracked yet. Log a delivery to start.</p>}
      <table className="data">
        <tbody>
          {rows.map((g) => {
            const full = Math.max(g.reorderLevel * 4, g.onHand, 0.001);
            return (
              <tr key={g.name}>
                <td>
                  {g.name}
                  {g.status !== 'ok' && (
                    <span className={`pill ${g.status === 'out' ? 'bad' : 'warn'}`} style={{ marginLeft: 6 }}>
                      {g.status === 'out' ? 'Out' : 'Low'}
                    </span>
                  )}
                </td>
                <td style={{ width: '35%' }}>
                  <div className={`stock-bar ${g.status}`}>
                    <span style={{ width: `${Math.min(100, (g.onHand / full) * 100)}%` }} />
                  </div>
                </td>
                <td className="r">
                  <strong>{g.onHand}</strong> <span className="faint">{g.unit}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

interface Po {
  forDate: string;
  total: number;
  lines: { ingredient: string; unit: string; onHand: number; needTomorrow: number; qty: number; unitPrice: number; total: number }[];
  draft: { summary: string; urgent: { ingredient: string; why: string }[]; message: string; source: string; model?: string; note?: string };
}

function PurchaseOrder() {
  const [po, setPo] = useState<Po | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      setPo(await api<Po>('/stock/purchase-order', { method: 'POST' }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>AI purchase order</h2>
          <span className="small faint">
            {po
              ? po.draft.source === 'rules'
                ? 'Rule-based draft (no LLM reachable)'
                : `Written by ${po.draft.source === 'gemini' ? 'Google Gemini' : po.draft.source === 'groq' ? 'Groq' : 'Claude'} · ${po.draft.model}`
              : 'Quantities from the forecast; the AI writes the order'}
          </span>
        </div>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={make}>
          {busy ? 'Drafting…' : po ? 'Redraft' : 'Draft order'}
        </button>
      </div>
      {err && <div className="notice bad small">{err}</div>}
      {po && (
        <>
          <strong>{po.draft.summary}</strong>
          {po.draft.urgent.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="section-label">Urgent</span>
              {po.draft.urgent.map((u) => (
                <div key={u.ingredient} className="small">
                  <span className="pill bad">{u.ingredient}</span> {u.why}
                </div>
              ))}
            </div>
          )}
          <table className="data">
            <thead>
              <tr>
                <th>Buy for {po.forDate}</th>
                <th className="r">Qty</th>
                <th className="r">₹</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.ingredient}>
                  <td>{l.ingredient}</td>
                  <td className="r">
                    {l.qty} <span className="faint">{l.unit}</span>
                  </td>
                  <td className="r">{rupees(l.total)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td />
                <td className="r">
                  <strong>{rupees(po.total)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          <span className="section-label">Message to supplier</span>
          <pre className="po-message">{po.draft.message}</pre>
          <div className="row wrap">
            <button
              className="btn btn-sm"
              onClick={async () => {
                await navigator.clipboard?.writeText(po.draft.message).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy message'}
            </button>
            <a className="btn btn-sm" href={`https://wa.me/?text=${encodeURIComponent(po.draft.message)}`} target="_blank" rel="noreferrer">
              Send on WhatsApp
            </a>
          </div>
        </>
      )}
    </section>
  );
}
