import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

// Small, dependency-free SVG charts. One series each (the title names it, so
// no legend), thin marks with 4px rounded data-ends, recessive grid, a hover
// tooltip on every mark, and a table view for exact numbers.

/** Draw at the container's real pixel width so text stays 11px on any screen. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(280, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1);
}

function ticks(max: number, n = 4) {
  return Array.from({ length: n + 1 }, (_, i) => (max / n) * i);
}

/** Bar with a rounded top and a square base. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

interface Tip {
  x: number; // % of width
  y: number; // % of height
  text: ReactNode;
}

function Frame({
  W,
  wrapRef,
  height,
  children,
  tip,
  table,
  showTable,
}: {
  W: number;
  wrapRef: RefObject<HTMLDivElement | null>;
  height: number;
  children: ReactNode;
  tip: Tip | null;
  table: ReactNode;
  showTable: boolean;
}) {
  return (
    <div className="chart" ref={wrapRef}>
      {showTable ? (
        table
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img">
            {children}
          </svg>
          {tip && (
            <div className="tip" style={{ left: `${tip.x}%`, top: `${tip.y}%` }}>
              {tip.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TableToggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <button className="linkish" onClick={() => set(!on)}>
      {on ? 'Chart' : 'Table'}
    </button>
  );
}

export interface BarDatum {
  key: string;
  label: string; // axis label
  name?: string; // full name for the table
  value: number;
  tip?: string;
  highlight?: boolean;
}

export function BarChart({
  data,
  height = 220,
  refLine,
  format = (v) => v.toFixed(0),
  showTable,
  valueName = 'Value',
  labelEvery = 1,
}: {
  data: BarDatum[];
  height?: number;
  refLine?: { value: number; label: string };
  format?: (v: number) => string;
  showTable: boolean;
  valueName?: string;
  labelEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, W] = useWidth();
  const pad = { l: 34, r: 8, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(...data.map((d) => d.value), refLine?.value ?? 0) * 1.05);
  const band = iw / data.length;
  const bw = Math.min(24, band - 2);
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  const tip =
    hover !== null
      ? {
          x: ((pad.l + band * hover + band / 2) / W) * 100,
          y: (y(data[hover].value) / height) * 100,
          text: data[hover].tip ?? `${data[hover].label}: ${format(data[hover].value)}`,
        }
      : null;

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Label</th>
          <th className="r">{valueName}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <td>{d.name ?? d.label}</td>
            <td className="r">{format(d.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <Frame W={W} wrapRef={wrapRef} height={height} tip={tip} table={table} showTable={showTable}>
      {ticks(max).map((t) => (
        <g key={t}>
          <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
            {format(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = pad.l + band * i + (band - bw) / 2;
        const h = Math.max(0, pad.t + ih - y(d.value));
        return (
          <g key={d.key}>
            {hover === i && <rect className="hover-col" x={pad.l + band * i} y={pad.t} width={band} height={ih} />}
            {h > 0 && <path className={`bar ${d.highlight ? 'hl' : ''}`} d={barPath(x, y(d.value), bw, h)} />}
            {i % labelEvery === 0 && (
              <text x={pad.l + band * i + band / 2} y={height - 8} textAnchor="middle">
                {d.label}
              </text>
            )}
            <rect
              className="hit"
              x={pad.l + band * i}
              y={pad.t}
              width={band}
              height={ih}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onTouchStart={() => setHover(i)}
            />
          </g>
        );
      })}
      {refLine && (
        <g pointerEvents="none">
          <line x1={pad.l} x2={W - pad.r} y1={y(refLine.value)} y2={y(refLine.value)} stroke="var(--text)" strokeDasharray="4 4" strokeWidth={1.5} />
          <text x={W - pad.r} y={y(refLine.value) - 5} textAnchor="end" style={{ fill: 'var(--text)', fontWeight: 600 }}>
            {refLine.label}
          </text>
        </g>
      )}
    </Frame>
  );
}

export interface LinePoint {
  key: string;
  label: string;
  value: number;
  low?: number; // forecast band
  high?: number;
  forecast?: boolean;
}

export function LineChart({
  data,
  height = 220,
  format = (v) => v.toFixed(0),
  showTable,
  labelEvery = 1,
  yMin,
  valueName = 'Value',
}: {
  data: LinePoint[];
  height?: number;
  format?: (v: number) => string;
  showTable: boolean;
  labelEvery?: number;
  yMin?: number;
  valueName?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, W] = useWidth();
  const pad = { l: 38, r: 12, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const hi = Math.max(...data.map((d) => d.high ?? d.value));
  const lo = yMin ?? 0;
  const max = niceMax(hi * 1.05);
  const step = data.length > 1 ? iw / (data.length - 1) : iw;
  const x = (i: number) => pad.l + step * i;
  const y = (v: number) => pad.t + ih - ((v - lo) / (max - lo)) * ih;

  const actual = data.map((d, i) => ({ d, i })).filter(({ d }) => !d.forecast);
  const fcStart = actual.length ? actual[actual.length - 1].i : 0;
  const fc = data.map((d, i) => ({ d, i })).filter(({ d, i }) => d.forecast || i === fcStart);
  const path = (pts: { d: LinePoint; i: number }[]) => pts.map(({ d, i }, k) => `${k ? 'L' : 'M'}${x(i)},${y(d.value)}`).join('');
  const bandPts = fc.filter(({ d }) => d.low !== undefined || d.forecast);
  const bandPath =
    bandPts.length > 1
      ? `M${bandPts.map(({ d, i }) => `${x(i)},${y(d.high ?? d.value)}`).join('L')}L${[...bandPts]
          .reverse()
          .map(({ d, i }) => `${x(i)},${y(d.low ?? d.value)}`)
          .join('L')}Z`
      : '';

  const tip =
    hover !== null
      ? {
          x: (x(hover) / W) * 100,
          y: (y(data[hover].value) / height) * 100,
          text: (
            <>
              {data[hover].label}
              {data[hover].forecast ? ' (forecast)' : ''}: <strong>{format(data[hover].value)}</strong>
              {data[hover].low !== undefined && data[hover].forecast ? ` · ${format(data[hover].low!)}–${format(data[hover].high!)}` : ''}
            </>
          ),
        }
      : null;

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Label</th>
          <th className="r">{valueName}</th>
          <th className="r">Range</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <td>
              {d.label}
              {d.forecast ? ' (forecast)' : ''}
            </td>
            <td className="r">{format(d.value)}</td>
            <td className="r">{d.forecast && d.low !== undefined ? `${format(d.low)}–${format(d.high!)}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <Frame W={W} wrapRef={wrapRef} height={height} tip={tip} table={table} showTable={showTable}>
      {ticks(max - lo).map((t) => (
        <g key={t}>
          <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(lo + t)} y2={y(lo + t)} />
          <text x={pad.l - 6} y={y(lo + t) + 4} textAnchor="end">
            {format(lo + t)}
          </text>
        </g>
      ))}
      {bandPath && <path className="band" d={bandPath} />}
      {actual.length > 1 && <path className="line" d={path(actual)} />}
      {fc.length > 1 && <path className="line" d={path(fc)} strokeDasharray="5 4" />}
      {data.map((d, i) => (
        <g key={d.key}>
          {i % labelEvery === 0 && (
            <text x={x(i)} y={height - 8} textAnchor="middle">
              {d.label}
            </text>
          )}
          {(hover === i || d.forecast) && <circle className="dot" cx={x(i)} cy={y(d.value)} r={hover === i ? 5 : 4} />}
        </g>
      ))}
      {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--text-3)" strokeWidth={1} pointerEvents="none" />}
      {data.map((d, i) => (
        <rect
          key={d.key}
          className="hit"
          x={x(i) - step / 2}
          y={pad.t}
          width={step}
          height={ih}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={() => setHover(i)}
        />
      ))}
    </Frame>
  );
}

/** Horizontal bars for a short ranked list, value printed at the bar end. */
export function RankBars({ rows, format = (v) => v.toFixed(0) }: { rows: { key: string; label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 8, alignItems: 'center' }}>
          <span className="small faint num">{i + 1}</span>
          <div>
            <div className="row between small">
              <span>{r.label}</span>
              <span className="num muted">{format(r.value)}</span>
            </div>
            <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, marginTop: 3 }}>
              <div style={{ width: `${(r.value / max) * 100}%`, height: '100%', background: 'var(--series)', borderRadius: '0 4px 4px 0' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
