// Demand forecasting: one ridge regression per menu item (plus one for total
// orders), trained on the daily history in Postgres.
//
// Features for day t (all known at forecast time, so multi-day forecasts run
// recursively on their own predictions):
//   weekday one-hot (Tue..Sat; Mon is the baseline)
//   trend           t / n
//   mean7           mean of the previous 6 operating days (one week)
//   sameDayLastWeek value 6 operating days back
//
// Honest evaluation: hold out the last week, forecast it from the weeks before,
// and compare against two baselines a canteen would actually use.

export interface Series {
  dates: string[];
  dows: number[];
  values: number[];
}

const WEEK = 6; // operating days per week (Mon–Sat)
const LAMBDA = 1.5;

function features(dow: number, t: number, n: number, past: number[]): number[] {
  const oneHot = [2, 3, 4, 5, 6].map((d) => (d === dow ? 1 : 0));
  const last = past.slice(-WEEK);
  const mean7 = last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
  const sameDay = past.length >= WEEK ? past[past.length - WEEK] : mean7;
  return [...oneHot, t / n, mean7, sameDay];
}

interface Model {
  beta: number[];
  mu: number[];
  sd: number[];
  yMean: number;
  residualSd: number;
  n: number;
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function fit(s: Series, upto = s.values.length): Model | null {
  const X: number[][] = [];
  const y: number[] = [];
  for (let t = WEEK; t < upto; t++) {
    X.push(features(s.dows[t], t, upto, s.values.slice(0, t)));
    y.push(s.values[t]);
  }
  if (X.length < 3) return null;
  const k = X[0].length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((a, r) => a + r[j], 0) / X.length);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(X.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  const yc = y.map((v) => v - yMean);
  const XtX = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => Z.reduce((a, r) => a + r[i] * r[j], 0) + (i === j ? LAMBDA : 0)),
  );
  const Xty = Array.from({ length: k }, (_, i) => Z.reduce((a, r, m) => a + r[i] * yc[m], 0));
  const beta = solve(XtX, Xty);
  const resid = Z.map((r, m) => yc[m] - r.reduce((a, v, j) => a + v * beta[j], 0));
  const dof = Math.max(1, resid.length - Math.min(k, resid.length - 1));
  const residualSd = Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / dof);
  return { beta, mu, sd, yMean, residualSd, n: upto };
}

function predictOne(m: Model, dow: number, t: number, past: number[]): number {
  const x = features(dow, t, m.n, past);
  const z = x.map((v, j) => (v - m.mu[j]) / m.sd[j]);
  return Math.max(0, m.yMean + z.reduce((a, v, j) => a + v * m.beta[j], 0));
}

export interface Forecast {
  date: string;
  dow: number;
  value: number;
  low: number;
  high: number;
}

/** Recursive multi-day forecast; 80% interval widens with the horizon. */
export function forecast(m: Model, s: Series, upto: number, future: { date: string; dow: number }[]): Forecast[] {
  const past = s.values.slice(0, upto);
  return future.map((f, h) => {
    const value = predictOne(m, f.dow, upto + h, past);
    past.push(value);
    const spread = 1.28 * m.residualSd * Math.sqrt(1 + h * 0.15);
    return { date: f.date, dow: f.dow, value, low: Math.max(0, value - spread), high: value + spread };
  });
}

function wape(actual: number[], pred: number[]) {
  const denom = actual.reduce((a, b) => a + b, 0) || 1;
  return actual.reduce((a, v, i) => a + Math.abs(v - pred[i]), 0) / denom;
}

export interface Backtest {
  holdoutDays: number;
  model: number;
  seasonalNaive: number;
  movingAverage: number;
}

/** Train on everything before the last week; score the last week. Lower WAPE is better. */
export function backtest(all: Series[]): Backtest | null {
  const n = all[0]?.values.length ?? 0;
  if (n < WEEK * 3) return null;
  const cut = n - WEEK;
  const a: number[] = [];
  const pm: number[] = [];
  const pn: number[] = [];
  const pa: number[] = [];
  for (const s of all) {
    const m = fit(s, cut);
    if (!m) continue;
    const future = s.dates.slice(cut).map((date, i) => ({ date, dow: s.dows[cut + i] }));
    const f = forecast(m, s, cut, future);
    const mean = s.values.slice(cut - WEEK, cut).reduce((x, y) => x + y, 0) / WEEK;
    for (let i = 0; i < WEEK; i++) {
      a.push(s.values[cut + i]);
      pm.push(f[i].value);
      pn.push(s.values[cut + i - WEEK]);
      pa.push(mean);
    }
  }
  return { holdoutDays: WEEK, model: wape(a, pm), seasonalNaive: wape(a, pn), movingAverage: wape(a, pa) };
}

/** Same holdout week, but train on only the most recent k days before it. */
export function learningCurve(all: Series[]): { trainDays: number; wape: number }[] {
  const n = all[0]?.values.length ?? 0;
  const cut = n - WEEK;
  const out: { trainDays: number; wape: number }[] = [];
  const sizes: number[] = [];
  for (let k = 9; k < cut; k += 3) sizes.push(k);
  sizes.push(cut);
  for (const k of sizes) {
    const a: number[] = [];
    const p: number[] = [];
    for (const s of all) {
      const start = cut - k;
      const sub: Series = { dates: s.dates.slice(start), dows: s.dows.slice(start), values: s.values.slice(start) };
      const m = fit(sub, k);
      if (!m) continue;
      const f = forecast(m, sub, k, sub.dates.slice(k).map((date, i) => ({ date, dow: sub.dows[k + i] })));
      for (let i = 0; i < WEEK; i++) {
        a.push(sub.values[k + i]);
        p.push(f[i].value);
      }
    }
    if (a.length) out.push({ trainDays: k, wape: wape(a, p) });
  }
  return out;
}
