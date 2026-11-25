import { useMemo, useState, type PointerEvent } from 'react';
import { ApiError, api, chime, clock, minutesUntil, notify, rupees, useEvent, useLive, useNow, type Combo, type MenuItem, type Order, type Slot, type User } from './api';

interface Refusal {
  message: string;
  nextSlot: Slot | null;
  alternatives: Slot[];
}

export function Buyer({ user }: { user: User }) {
  const menu = useLive<MenuItem[]>('/menu', ['menu']);
  const slots = useLive<{ date: string; slots: Slot[] }>('/slots', ['slots', 'settings'], 30_000);
  const combo = useLive<Combo | null>('/combo', []);
  const mine = useLive<Order[]>('/orders/mine', ['orders']);

  const [cart, setCart] = useState<Record<string, number>>({});
  const [cat, setCat] = useState<string>('All');
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justPlaced, setJustPlaced] = useState<number | null>(null);
  const [readyMsg, setReadyMsg] = useState<string | null>(null);

  useEvent('orders', (e) => {
    if (e.kind !== 'status' || e.status !== 'ready') return;
    const o = mine.data?.find((x) => x.id === e.id);
    if (!o) return;
    const msg = `Order #${o.token} is ready. Pick it up at the counter.`;
    setReadyMsg(msg);
    chime();
    navigator.vibrate?.([120, 80, 120]);
    notify('Your food is ready', msg);
  });

  const items = menu.data ?? [];
  const cats = ['All', ...new Set(items.map((i) => i.category))];
  const shown = cat === 'All' ? items : items.filter((i) => i.category === cat);
  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  const subtotal = items.reduce((s, i) => s + i.price * (cart[i.id] ?? 0), 0);
  const comboHit = combo.data && combo.data.items.every((c) => cart[c.id]);
  const discount = comboHit ? combo.data!.fullPrice - combo.data!.price : 0;

  const today = slots.data?.date;
  const active = (mine.data ?? [])
    .filter((o) => o.date === today && ['placed', 'cooking', 'ready'].includes(o.status))
    .sort((a, b) => (a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1) || b.id - a.id);
  const past = (mine.data ?? []).filter((o) => !active.includes(o)).slice(0, 5);
  const open = (slots.data?.slots ?? []).filter((s) => s.status === 'open' || s.status === 'busy');
  const quietest = (slots.data?.slots ?? []).find((s) => s.quiet);
  const pickedSlot = slots.data?.slots.find((s) => s.slot === slot);

  const add = (id: string, d = 1) => {
    navigator.vibrate?.(d > 0 ? 12 : 6);
    return setCart((c) => {
      const q = Math.max(0, (c[id] ?? 0) + d);
      const next = { ...c, [id]: q };
      if (!q) delete next[id];
      return next;
    });
  };

  async function place(at = slot) {
    if (!at || !count) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const o = await api<{ id: number; slot: string }>('/orders', {
        body: { slot: at, items: Object.entries(cart).map(([id, qty]) => ({ id, qty })) },
      });
      setCart({});
      setSlot(null);
      setJustPlaced(o.id);
      navigator.vibrate?.([20, 60, 30]);
      mine.reload();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'SLOT_FULL' || e.code === 'SLOT_CLOSED')) {
        setRefusal({ message: e.message, nextSlot: e.body.nextSlot ?? null, alternatives: e.body.alternatives ?? [] });
        setSlot(null);
        slots.reload();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: number) {
    if (!confirm('Cancel this order? Your slot place goes back to others.')) return;
    await api(`/orders/${id}/cancel`, { method: 'POST' }).catch((e) => alert(e.message));
    mine.reload();
  }

  return (
    <main className="buyer">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="live-dot" /> Campus canteen · order ahead
          </span>
          <h1 className="h3d">
            Skip the <span>queue.</span>
          </h1>
          <p className="hero-sub">Hi {user.name.split(' ')[0]}! Tap your food, pick a 15-minute slot, walk in and collect it hot.</p>
          <div className="hero-stats">
            <div>
              <strong className="num">{open.length}</strong>
              <span>slots open today</span>
            </div>
            <div>
              <strong>{quietest ? quietest.label.split('–')[0] : '—'}</strong>
              <span>quietest slot</span>
            </div>
            <div>
              <strong>3</strong>
              <span>taps to order</span>
            </div>
          </div>
        </div>
        <div className="hero-art" aria-hidden>
          {['masala-dosa', 'samosa', 'chai'].map((id, k) => (
            <div key={id} className={`float-card f${k}`}>
              <img src={`/food/${id}.jpg`} alt="" />
            </div>
          ))}
        </div>
      </section>

      {readyMsg && (
        <div className="notice good row between ready-banner" role="status">
          <strong>{readyMsg}</strong>
          <button className="linkish" onClick={() => setReadyMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="buyer-grid">
        <div className="buyer-main">
          {active.length > 0 && (
            <section className="stack area-tickets" aria-label="Your orders today">
              {active.slice(0, 1).map((o) => (
                <Ticket key={o.id} order={o} fresh={o.id === justPlaced} onCancel={() => cancel(o.id)} />
              ))}
              {active.length > 1 && (
                <div className="panel stack" style={{ gap: 6 }}>
                  <span className="section-label">Also today</span>
                  {active.slice(1).map((o) => (
                    <div key={o.id} className="row between small">
                      <span>
                        <strong className="mono">#{o.token}</strong> · {o.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}
                      </span>
                      <span className={o.status === 'ready' ? 'pill good' : 'muted'}>
                        {o.status === 'ready' ? 'Ready' : `${o.slotLabel.split('–')[0]} · ${clock(o.readyEta)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {combo.data && (
            <section className="combo area-combo">
              <div className="combo-pics" aria-hidden>
                {combo.data.items.map((c) => (
                  <img key={c.id} src={`/food/${c.id}.jpg`} alt="" />
                ))}
              </div>
              <div className="combo-copy">
                <span className="eyebrow">Combo of the day</span>
                <div className="combo-name">{combo.data.items.map((i) => i.name).join(' + ')}</div>
                <div className="small combo-reason">{combo.data.reason}</div>
              </div>
              <div className="combo-buy">
                <div className="combo-price num">
                  {rupees(combo.data.price)} <s>{rupees(combo.data.fullPrice)}</s>
                </div>
                <button
                  className="btn btn-dark"
                  disabled={Boolean(comboHit) || combo.data.items.some((c) => !items.find((i) => i.id === c.id)?.available)}
                  onClick={() => combo.data!.items.forEach((c) => !cart[c.id] && add(c.id))}
                >
                  {comboHit ? 'Added' : 'Add combo'}
                </button>
              </div>
            </section>
          )}

          <section className="stack area-menu" aria-label="Menu">
            <div className="row between">
              <h2 className="step">
                <span>1</span> Pick your food
              </h2>
              {count > 0 && (
                <button className="linkish" onClick={() => setCart({})}>
                  Clear
                </button>
              )}
            </div>
            <div className="cats" role="group" aria-label="Category">
              {cats.map((c) => (
                <button key={c} className="chip" data-cat={c} aria-pressed={cat === c} onClick={() => setCat(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="menu">
              {shown.map((i) => (
                <button
                  key={i.id}
                  className="item"
                  data-cat={i.category}
                  data-in={Boolean(cart[i.id])}
                  disabled={!i.available}
                  onClick={() => add(i.id)}
                  onPointerMove={tilt}
                  onPointerLeave={untilt}
                  aria-label={`Add ${i.name}, ${rupees(i.price)}`}
                >
                  {cart[i.id] ? <span className="qty">{cart[i.id]}</span> : null}
                  <span className="photo" aria-hidden>
                    <img src={`/food/${i.id}.jpg`} alt="" loading="lazy" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
                    <span className="price-tag num">{i.available ? rupees(i.price) : 'Sold out'}</span>
                  </span>
                  <span className="item-body">
                    <span className="name">
                      {i.veg && <span className="veg" title="Veg" />}
                      {i.name}
                    </span>
                    <span className="item-meta">
                      <span className="cat-dot" /> {i.category} · {i.prepMinutes} min
                    </span>
                  </span>
                  <span className="add-hint" aria-hidden>
                    {cart[i.id] ? '+ one more' : '+ Add'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="buyer-side">
          {slots.data && (
            <div className="area-meter">
              <QueueMeter slots={slots.data.slots} />
            </div>
          )}

          <section className="stack area-slots panel" aria-label="Pickup slot">
            <div className="row between">
              <h2 className="step">
                <span>2</span> Pick a pickup slot
              </h2>
              <span className="small faint">15 min each</span>
            </div>
            {slots.data && <SlotHint slots={slots.data.slots} />}
            {refusal && (
              <div className="notice bad stack" role="alert">
                <strong>{refusal.message}</strong>
                {refusal.nextSlot ? (
                  <div className="row wrap">
                    <button className="btn btn-dark" disabled={busy || !count} onClick={() => place(refusal.nextSlot!.slot)}>
                      Book {refusal.nextSlot.label} instead
                    </button>
                    {refusal.alternatives.slice(1).map((a) => (
                      <button key={a.slot} className="btn btn-sm" onClick={() => (setSlot(a.slot), setRefusal(null))}>
                        {a.label} · {a.remaining} left
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="small">Every later slot is full today.</span>
                )}
              </div>
            )}
            <div className="slots">
              {(slots.data?.slots ?? []).map((s) => (
                <SlotButton key={s.slot} s={s} selected={slot === s.slot} onPick={() => (navigator.vibrate?.(10), setSlot(s.slot), setRefusal(null))} />
              ))}
            </div>
            <div className="legend small">
              <span>
                <i className="lg open" /> open
              </span>
              <span>
                <i className="lg busy" /> filling up
              </span>
              <span>
                <i className="lg full" /> full
              </span>
            </div>
          </section>

          {error && <div className="notice bad small">{error}</div>}

          <div className="cartpanel">
            <div className="row between">
              <h2 className="step only-wide">
                <span>3</span> Your order
              </h2>
              <span className="small muted">
                {count ? `${count} item${count > 1 ? 's' : ''}` : 'Nothing picked yet'}
                {pickedSlot ? ` · ${pickedSlot.label.split('–')[0]}` : ''}
              </span>
            </div>
            {count > 0 && (
              <div className="cart-lines">
                {items
                  .filter((i) => cart[i.id])
                  .map((i) => (
                    <div key={i.id} className="cart-line">
                      <img src={`/food/${i.id}.jpg`} alt="" />
                      <span className="grow">{i.name}</span>
                      <span className="stepper">
                        <button aria-label={`Remove one ${i.name}`} onClick={() => add(i.id, -1)}>
                          −
                        </button>
                        <span className="num">{cart[i.id]}</span>
                        <button aria-label={`Add one ${i.name}`} onClick={() => add(i.id)}>
                          +
                        </button>
                      </span>
                      <span className="num line-total">{rupees(i.price * cart[i.id])}</span>
                    </div>
                  ))}
                {discount > 0 && (
                  <div className="cart-line discount">
                    <span className="grow">Combo discount</span>
                    <span className="num">−{rupees(discount)}</span>
                  </div>
                )}
              </div>
            )}
            <button className="btn btn-primary btn-block btn-3d" disabled={busy || !count || !slot} onClick={() => place()}>
              {!count ? 'Pick something to eat' : !slot ? 'Now pick a pickup slot' : busy ? 'Placing…' : `Place order · ${rupees(subtotal - discount)}`}
            </button>
          </div>

          {past.length > 0 && (
            <section className="stack panel area-extra" aria-label="Recent orders">
              <span className="section-label">Recent</span>
              {past.map((o) => (
                <div key={o.id} className="row between small">
                  <span>
                    #{o.token} · {o.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}
                  </span>
                  <span className="muted">
                    {o.date === today ? o.slotLabel : o.date} · {o.status}
                  </span>
                </div>
              ))}
            </section>
          )}
          <div className="area-extra">
            <PhotoCredits />
          </div>
        </aside>
      </div>
    </main>
  );
}

/** 3D tilt that follows the mouse (touch keeps cards flat). */
function tilt(e: PointerEvent<HTMLElement>) {
  if (e.pointerType !== 'mouse') return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  el.style.setProperty('--ry', `${(x - 0.5) * 14}deg`);
  el.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
  el.style.setProperty('--mx', `${x * 100}%`);
  el.style.setProperty('--my', `${y * 100}%`);
}
function untilt(e: PointerEvent<HTMLElement>) {
  e.currentTarget.style.setProperty('--rx', '0deg');
  e.currentTarget.style.setProperty('--ry', '0deg');
}

function PhotoCredits() {
  const [list, setList] = useState<{ id: string; page: string; author: string; license: string }[] | null>(null);
  return (
    <details
      className="photo-credit"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && !list)
          fetch('/food/credits.json')
            .then((r) => r.json())
            .then(setList)
            .catch(() => setList([]));
      }}
    >
      <summary>Food photos from Wikimedia Commons, used under their licences</summary>
      {list?.map((c) => (
        <div key={c.id}>
          {c.id}:{' '}
          <a href={c.page} target="_blank" rel="noreferrer">
            {c.author || 'see source'}
          </a>
          , {c.license}
        </div>
      ))}
    </details>
  );
}

function SlotButton({ s, selected, onPick }: { s: Slot; selected: boolean; onPick: () => void }) {
  // Full slots stay tappable on purpose: the server is the one that refuses,
  // and its refusal carries the next free slot (also covers a slot filling
  // between page load and tap).
  const unavailable = s.status === 'closed';
  const tag =
    s.status === 'closed' ? 'Passed' : s.status === 'full' ? 'Full' : s.quiet ? 'Quiet · no wait' : s.status === 'busy' ? `${s.remaining} left` : `${s.remaining} left`;
  return (
    <button
      className="slot"
      data-status={s.status}
      data-quiet={s.quiet}
      aria-pressed={selected}
      disabled={unavailable}
      onClick={onPick}
      aria-label={`${s.label}, ${tag}`}
      style={{ ['--fill' as string]: `${Math.min(100, s.fill * 100)}%` }}
    >
      <span className="time">{s.label.split('–')[0]}</span>
      <span className="meter" aria-hidden>
        <span />
      </span>
      <span className="slot-tag">{tag}</span>
    </button>
  );
}

function SlotHint({ slots }: { slots: Slot[] }) {
  const busiest = [...slots].filter((s) => s.status !== 'closed').sort((a, b) => b.forecastOrders - a.forecastOrders).slice(0, 3);
  const quiet = slots.filter((s) => s.quiet).slice(0, 3);
  if (!busiest.length) return null;
  return (
    <p className="small muted">
      Usually busiest: <strong>{busiest.map((s) => s.label.split('–')[0]).join(', ')}</strong>.
      {quiet.length > 0 && (
        <>
          {' '}
          Quieter now: <strong className="quiet-text">{quiet.map((s) => s.label.split('–')[0]).join(', ')}</strong>.
        </>
      )}
    </p>
  );
}

/** How crowded the counter is right now, from the live slot bookings. */
function QueueMeter({ slots }: { slots: Slot[] }) {
  const now = useNow(30_000);
  const ist = new Date(now + 330 * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const current = useMemo(() => slots.find((s) => toMin(s.slot) <= minutes && minutes < toMin(s.slot) + 15) ?? null, [slots, minutes]);
  if (!current) {
    const open = slots.filter((s) => s.status === 'open' || s.status === 'busy').length;
    return (
      <div className="panel meter-card row between">
        <div>
          <span className="section-label">Counter</span>
          <div className="meter-word">Closed now</div>
          <span className="small muted">Open 11:00 am–3:00 pm. Book ahead for any slot.</span>
        </div>
        <span className="pill accent plain">{open} slots open</span>
      </div>
    );
  }
  const level = current.fill >= 1 ? 'bad' : current.fill >= 0.75 ? 'warn' : 'good';
  const word = level === 'bad' ? 'Packed' : level === 'warn' ? 'Busy' : 'Calm';
  const pct = Math.min(100, current.fill * 100);
  return (
    <div className="panel meter-card row">
      <div className="gauge" data-level={level} style={{ ['--p' as string]: `${pct}` }} aria-hidden>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <span className="section-label">Counter right now · {current.label}</span>
        <div className="meter-word">
          {word} <span className={`pill ${level}`}>{current.remaining} places left</span>
        </div>
        <span className="small muted num">
          {current.booked} of {current.capacity} pickups booked. Pre-booked orders skip the line.
        </span>
      </div>
    </div>
  );
}

function toMin(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const STEP: Record<string, number> = { placed: 1, cooking: 2, ready: 3, collected: 4 };
const STEP_NAMES = ['Placed', 'Cooking', 'Ready'];

function Ticket({ order: o, fresh, onCancel }: { order: Order; fresh: boolean; onCancel: () => void }) {
  const now = useNow(15_000);
  const mins = minutesUntil(o.readyEta, now);
  const status =
    o.status === 'ready'
      ? 'Ready! Show your token at the counter.'
      : o.status === 'cooking'
        ? `Cooking now. Ready ${mins !== null && mins > 0 ? `in about ${mins} min` : 'any moment'}.`
        : `Ready at ${clock(o.readyEta)}${mins !== null && mins > 0 ? ` (in ${mins} min)` : ''}.`;
  return (
    <article className="ticket" data-status={o.status} data-fresh={fresh} aria-live={fresh ? 'polite' : undefined}>
      <div className="ticket-head">
        <div>
          <div className="section-label">{fresh ? 'Order placed' : 'Your token'}</div>
          <div className="token">#{o.token}</div>
        </div>
        <div className="ticket-slot">
          <div className="section-label">Pickup</div>
          <div className="num">{o.slotLabel}</div>
        </div>
      </div>
      <div className="ticket-body">
        <div className="steps">
          {STEP_NAMES.map((n, k) => (
            <div key={n} className={STEP[o.status] >= k + 1 ? 'on' : ''}>
              <span />
              <small>{n}</small>
            </div>
          ))}
        </div>
        <strong className="ticket-status">{status}</strong>
        <span className="small muted">
          {o.items.map((i) => `${i.name} ×${i.qty}`).join(', ')} · {rupees(o.total)}
          {o.discount > 0 ? ` (saved ${rupees(o.discount)})` : ''}
        </span>
        {o.status === 'placed' && (
          <div>
            <button className="linkish" onClick={onCancel}>
              Cancel order
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
