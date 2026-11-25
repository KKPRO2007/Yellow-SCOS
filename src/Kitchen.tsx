import { useState } from 'react';
import { api, chime, clock, notify, useEvent, useLive, type LiveEvent, type MenuItem, type Order, type Slot, type User } from './api';

interface KitchenData {
  today: string;
  current: string;
  orders: Order[];
  slots: Slot[];
  cookAhead: {
    slot: string;
    label: string;
    booked: number;
    capacity: number;
    items: { id: string; name: string; booked: number; expected: number; cook: number }[];
  }[];
}

const NEXT: Record<string, { to: Order['status']; label: string } | undefined> = {
  placed: { to: 'cooking', label: 'Start' },
  cooking: { to: 'ready', label: 'Ready' },
  ready: { to: 'collected', label: 'Collected' },
};

export function Kitchen({ user }: { user: User }) {
  const k = useLive<KitchenData>('/kitchen', ['orders', 'slots', 'menu', 'settings'], 60_000);
  const menu = useLive<MenuItem[]>('/menu', ['menu']);
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [toasts, setToasts] = useState<(LiveEvent & { at: number })[]>([]);
  const [sound, setSound] = useState(true);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission);

  // New-order alerts: chime + toast, and a system notification if the tab is hidden.
  useEvent('orders', (e) => {
    if (e.kind !== 'new') return;
    const t = { ...e, at: Date.now() };
    setToasts((ts) => [t, ...ts].slice(0, 4));
    setTimeout(() => setToasts((ts) => ts.filter((x) => x !== t)), 8000);
    if (sound) chime();
    notify(`New order #${e.token}`, `${e.slotLabel}: ${(e.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(', ')}`);
  });

  if (!k.data) return <main className="page">{k.error ? <div className="notice bad">{k.error}</div> : <p className="muted">Loading kitchen…</p>}</main>;
  const { orders, cookAhead, current } = k.data;

  async function move(ids: number[], to: Order['status']) {
    setPending((p) => new Set([...p, ...ids]));
    // Optimistic: move the cards now, the live stream confirms.
    k.setData((d) => d && { ...d, orders: d.orders.map((o) => (ids.includes(o.id) ? { ...o, status: to } : o)).filter((o) => o.status !== 'collected') });
    await Promise.all(ids.map((id) => api(`/orders/${id}/status`, { method: 'PATCH', body: { status: to } }).catch(() => {})));
    setPending((p) => new Set([...p].filter((x) => !ids.includes(x))));
    k.reload();
  }

  // Columns: every slot with open orders, from the earliest unfinished one.
  const bySlot = new Map<string, Order[]>();
  for (const o of orders) bySlot.set(o.slot, [...(bySlot.get(o.slot) ?? []), o]);
  const slotKeys = [...bySlot.keys()].sort();
  const late = slotKeys.filter((s) => s < current && bySlot.get(s)!.some((o) => o.status !== 'ready'));
  const cols = [...new Set([...late, ...slotKeys.filter((s) => s >= current)])];
  const visible = showAll ? cols : cols.slice(0, 4);

  // "Cook next": what is booked and not yet ready in the first column.
  const focus = visible[0];
  const todo = new Map<string, number>();
  for (const o of bySlot.get(focus) ?? []) if (o.status !== 'ready') for (const i of o.items) todo.set(i.name, (todo.get(i.name) ?? 0) + i.qty);
  const todoList = [...todo].sort((a, b) => b[1] - a[1]);

  return (
    <main className="page stack">
      <div className="page-title kitchen">
        <div>
          <h1>Kitchen</h1>
          <p className="small muted">
            {orders.filter((o) => o.status !== 'ready').length} to cook · {orders.filter((o) => o.status === 'ready').length} waiting for pickup
          </p>
        </div>
        <div className="row wrap">
          {user.role === 'admin' && <span className="pill plain">Viewing as shopkeeper</span>}
          <button className="btn btn-sm" aria-pressed={sound} onClick={() => (setSound(!sound), !sound && chime())}>
            Sound {sound ? 'on' : 'off'}
          </button>
          {perm === 'default' && (
            <button className="btn btn-sm" onClick={async () => setPerm(await Notification.requestPermission())}>
              Enable pop-up alerts
            </button>
          )}
        </div>
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.at + String(t.id)} className="toast">
            <div className="row between">
              <strong>New order #{t.token}</strong>
              <span className="small">{t.slotLabel}</span>
            </div>
            <div className="small">{(t.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(', ')}</div>
          </div>
        ))}
      </div>

      {focus && (
        <section className="notice accent stack" aria-label="Cook next">
          <div className="row between">
            <span className="section-label">
              Cook next · {k.data.slots.find((s) => s.slot === focus)?.label}
              {focus < current ? ' · running late' : ''}
            </span>
          </div>
          {todoList.length ? (
            <div className="row wrap" style={{ gap: 14 }}>
              {todoList.map(([name, n]) => (
                <span key={name} style={{ fontSize: 17 }}>
                  <strong className="mono">{n}×</strong> {name}
                </span>
              ))}
            </div>
          ) : (
            <span className="small">All orders in this slot are ready.</span>
          )}
        </section>
      )}

      <div className="grid grid-kitchen">
        <section aria-label="Orders by slot" className="stack">
          {cols.length === 0 && <div className="card muted">No open orders. New ones appear here instantly.</div>}
          <div className="board">
            {visible.map((s) => {
              const list = bySlot.get(s)!;
              const info = k.data!.slots.find((x) => x.slot === s);
              const placed = list.filter((o) => o.status === 'placed').map((o) => o.id);
              const cooking = list.filter((o) => o.status === 'cooking').map((o) => o.id);
              return (
                <div key={s} className="card">
                  <div className="col-head">
                    <div>
                      <h3 className="num">{info?.label}</h3>
                      <span className="small faint num">
                        {list.length} open · {info?.booked}/{info?.capacity} booked
                      </span>
                    </div>
                    {s < current ? <span className="pill bad">Late</span> : s === current ? <span className="pill warn">Now</span> : null}
                  </div>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <button className="btn btn-sm" disabled={!placed.length} onClick={() => move(placed, 'cooking')}>
                      Start all ({placed.length})
                    </button>
                    <button className="btn btn-sm" disabled={!cooking.length} onClick={() => move(cooking, 'ready')}>
                      All ready ({cooking.length})
                    </button>
                  </div>
                  <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                    {list.map((o) => {
                      const next = NEXT[o.status];
                      return (
                        <div key={o.id} className="korder" data-status={o.status}>
                          <div className="row between">
                            <span className="mono" style={{ fontWeight: 700 }}>
                              #{o.token}
                            </span>
                            <span className="small faint">
                              {o.customer ?? 'Walk-in'} · ready {clock(o.readyEta)}
                            </span>
                          </div>
                          <ul>
                            {o.items.map((i) => (
                              <li key={i.id}>
                                {i.qty}× {i.name}
                              </li>
                            ))}
                          </ul>
                          {next && (
                            <button
                              className={`btn btn-sm ${o.status === 'cooking' ? 'btn-primary' : ''}`}
                              disabled={pending.has(o.id)}
                              onClick={() => move([o.id], next.to)}
                            >
                              {next.label}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {cols.length > 4 && (
            <button className="btn" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer slots' : `Show ${cols.length - 4} later slots`}
            </button>
          )}
        </section>

        <aside className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Cook ahead</h2>
              <span className="small faint">booked + forecast</span>
            </div>
            <p className="small muted" style={{ marginBottom: 8 }}>
              What to have ready for the next hour: the larger of what is already booked and what the forecast expects in each slot.
            </p>
            {cookAhead.map((c) => (
              <div key={c.slot} style={{ marginTop: 10 }}>
                <div className="row between small">
                  <strong className="num">{c.label}</strong>
                  <span className="faint num">
                    {c.booked}/{c.capacity} booked
                  </span>
                </div>
                <div className="cook-list">
                  {c.items.slice(0, 5).map((i) => (
                    <div key={i.id} className="cook-row">
                      <span>{i.name}</span>
                      <span className="cook-n">{i.cook}</span>
                      <span className="small faint" style={{ gridColumn: '1 / -1' }}>
                        {i.booked} booked · {i.expected} expected
                      </span>
                    </div>
                  ))}
                  {c.items.length === 0 && <span className="small faint">Nothing expected.</span>}
                </div>
              </div>
            ))}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Stock</h2>
              <span className="small faint">tap to mark sold out</span>
            </div>
            {(menu.data ?? []).map((m) => (
              <div key={m.id} className="toggle-row">
                <span className={m.available ? '' : 'faint'}>
                  {m.name}
                  {!m.available && <span className="pill bad" style={{ marginLeft: 6 }}>Sold out</span>}
                </span>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={m.available}
                  aria-label={`${m.name} available`}
                  onClick={async () => {
                    menu.setData((d) => d && d.map((x) => (x.id === m.id ? { ...x, available: !m.available } : x)));
                    await api(`/menu/${m.id}`, { method: 'PATCH', body: { available: !m.available } }).catch((e) => alert(e.message));
                  }}
                />
              </div>
            ))}
          </section>
        </aside>
      </div>
    </main>
  );
}
