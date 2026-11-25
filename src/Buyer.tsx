import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import { ApiError, api, chime, clock, minutesUntil, notify, rupees, useEvent, useLive, useNow, type Combo, type MenuItem, type Order, type Slot, type User } from './api';
import { PaySheet } from './PaySheet';

interface Refusal {
  message: string;
  slot: string | null;
  nextSlot: Slot | null;
  alternatives: Slot[];
}
interface Usual {
  items: { id: string; name: string; qty: number; price: number }[];
  slot: string;
  slotLabel: string;
  times: number;
  total: number;
}
interface Wait {
  slot: string;
  slotLabel: string;
  notified: boolean;
  position: number;
}

// Cart keys are "person::itemId"; person '' is you, anything else a friend.
const ME = '';
const keyOf = (person: string, id: string) => `${person}::${id}`;
const splitKey = (k: string) => {
  const i = k.lastIndexOf('::');
  return { person: k.slice(0, i), id: k.slice(i + 2) };
};
const BREAK_KEY = 'yellow.break';

export function Buyer({ user }: { user: User }) {
  const menu = useLive<MenuItem[]>('/menu', ['menu']);
  const slots = useLive<{ date: string; slots: Slot[] }>('/slots', ['slots', 'settings'], 30_000);
  const combo = useLive<Combo | null>('/combo', []);
  const mine = useLive<Order[]>('/orders/mine', ['orders']);
  const usual = useLive<Usual | null>('/orders/usual', []);
  const waits = useLive<Wait[]>('/waitlist/mine', ['orders']);

  const [cart, setCart] = useState<Record<string, number>>({});
  const [people, setPeople] = useState<string[]>([]); // friends in a group order
  const [who, setWho] = useState<string>(ME);
  const [friendName, setFriendName] = useState('');
  const [cat, setCat] = useState<string>('All');
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justPlaced, setJustPlaced] = useState<number | null>(null);
  const [readyMsg, setReadyMsg] = useState<string | null>(null);
  const [freed, setFreed] = useState<{ slot: string; slotLabel: string } | null>(null);
  const [paying, setPaying] = useState<{ id: number; total: number } | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);
  const [brk, setBrk] = useState<{ from: string; to: string }>(() => {
    try {
      return JSON.parse(localStorage.getItem(BREAK_KEY) ?? '') as { from: string; to: string };
    } catch {
      return { from: '12:45', to: '13:45' };
    }
  });
  useEffect(() => localStorage.setItem(BREAK_KEY, JSON.stringify(brk)), [brk]);

  useEvent('orders', (e) => {
    if (e.kind === 'status' && e.status === 'ready') {
      const o = mine.data?.find((x) => x.id === e.id);
      if (!o) return;
      const msg = `Order #${o.token} is ready. Pick it up at the counter.`;
      setReadyMsg(msg);
      chime();
      navigator.vibrate?.([120, 80, 120]);
      notify('Your food is ready', msg);
    }
    if (e.kind === 'waitlist' && e.userId === user.id && e.slot) {
      setFreed({ slot: e.slot, slotLabel: e.slotLabel ?? e.slot });
      chime();
      navigator.vibrate?.([80, 60, 80, 60, 80]);
      notify('A place opened up', `${e.slotLabel} has a free place. Book it now before someone else does.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  const items = menu.data ?? [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const cats = ['All', ...new Set(items.map((i) => i.category))];
  const shown = cat === 'All' ? items : items.filter((i) => i.category === cat);
  const lines = Object.entries(cart).map(([k, qty]) => ({ ...splitKey(k), qty }));
  const qtyOf = (id: string) => lines.filter((l) => l.id === id).reduce((a, l) => a + l.qty, 0);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + (byId.get(l.id)?.price ?? 0) * l.qty, 0);
  const comboHit = combo.data && combo.data.items.every((c) => qtyOf(c.id) > 0);
  const discount = comboHit ? combo.data!.fullPrice - combo.data!.price : 0;
  const group = people.length > 0;

  const today = slots.data?.date;
  const active = (mine.data ?? [])
    .filter((o) => o.date === today && ['placed', 'cooking', 'ready'].includes(o.status))
    .sort((a, b) => (a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1) || b.id - a.id);
  const past = (mine.data ?? []).filter((o) => !active.includes(o)).slice(0, 5);
  const allSlots = slots.data?.slots ?? [];
  const open = allSlots.filter((s) => s.status === 'open' || s.status === 'busy');
  const quietest = allSlots.find((s) => s.quiet);
  const pickedSlot = allSlots.find((s) => s.slot === slot);

  const add = (id: string, d = 1, person = who) => {
    navigator.vibrate?.(d > 0 ? 12 : 6);
    setCart((c) => {
      const k = keyOf(person, id);
      const q = Math.max(0, (c[k] ?? 0) + d);
      const next = { ...c, [k]: q };
      if (!q) delete next[k];
      return next;
    });
  };

  function addFriend() {
    const name = friendName.trim().slice(0, 30);
    if (!name || name === ME || people.includes(name) || people.length >= 5) return;
    setPeople([...people, name]);
    setWho(name);
    setFriendName('');
  }
  function removeFriend(name: string) {
    setPeople(people.filter((p) => p !== name));
    setCart((c) => Object.fromEntries(Object.entries(c).filter(([k]) => splitKey(k).person !== name)));
    if (who === name) setWho(ME);
  }

  /** Pick for me: the quietest open slot inside my break, else the nearest after it. */
  function pickForMe() {
    const inBreak = open.filter((s) => s.slot >= brk.from && s.slot < brk.to);
    const pool = inBreak.length ? inBreak : open.filter((s) => s.slot >= brk.from);
    const best = [...(pool.length ? pool : open)].sort((a, b) => a.fill - b.fill || a.slot.localeCompare(b.slot))[0];
    if (!best) return setPickNote('Every slot is full today.');
    setSlot(best.slot);
    setRefusal(null);
    navigator.vibrate?.(14);
    setPickNote(
      inBreak.length
        ? `Picked ${best.label}: the quietest slot in your break (${best.booked}/${best.capacity} booked).`
        : `Nothing free in your break, so picked ${best.label}, the next quiet slot.`,
    );
  }

  async function place(at = slot, override?: { id: string; qty: number; for?: string }[]) {
    const body = override ?? lines.map((l) => ({ id: l.id, qty: l.qty, ...(l.person ? { for: l.person } : {}) }));
    if (!at || !body.length) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const o = await api<{ id: number; slot: string; total: number }>('/orders', { body: { slot: at, items: body } });
      if (!override) {
        setCart({});
        setPeople([]);
        setWho(ME);
      }
      setSlot(null);
      setFreed(null);
      setPickNote(null);
      setJustPlaced(o.id);
      navigator.vibrate?.([20, 60, 30]);
      mine.reload();
      waits.reload();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setPaying({ id: o.id, total: o.total });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'SLOT_FULL' || e.code === 'SLOT_CLOSED')) {
        if (override) setCart(Object.fromEntries(override.map((l) => [keyOf(l.for ?? ME, l.id), l.qty])));
        setRefusal({ message: e.message, slot: e.body.slot ?? at, nextSlot: e.body.nextSlot ?? null, alternatives: e.body.alternatives ?? [] });
        setSlot(null);
        slots.reload();
      } else {
        setError((e as Error).message);
        if (e instanceof ApiError && e.code === 'OUT_OF_STOCK') menu.reload();
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: number) {
    if (!confirm('Cancel this order? Your slot place goes back to others.')) return;
    await api(`/orders/${id}/cancel`, { method: 'POST' }).catch((e) => alert(e.message));
    mine.reload();
  }

  async function joinWaitlist(s: string) {
    try {
      waits.setData(await api<Wait[]>('/waitlist', { body: { slot: s } }));
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function leaveWaitlist(s: string) {
    waits.setData(await api<Wait[]>(`/waitlist/${s}`, { method: 'DELETE' }));
  }

  const usualOk = usual.data && usual.data.items.every((i) => byId.get(i.id)?.available !== false);
  const waiting = waits.data ?? [];

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

      {freed && (
        <div className="notice good freed-banner" role="alert">
          <div className="stack" style={{ gap: 4 }}>
            <strong>A place just opened at {freed.slotLabel}!</strong>
            <span className="small">You were first on the waitlist. Book it before someone else does.</span>
          </div>
          <div className="row wrap">
            {count > 0 ? (
              <button className="btn btn-dark" disabled={busy} onClick={() => place(freed.slot)}>
                Book {freed.slotLabel.split('–')[0]} now
              </button>
            ) : usual.data ? (
              <button className="btn btn-dark" disabled={busy} onClick={() => place(freed.slot, usual.data!.items.map((i) => ({ id: i.id, qty: i.qty })))}>
                Book my usual at {freed.slotLabel.split('–')[0]}
              </button>
            ) : (
              <button className="btn btn-dark" onClick={() => (setSlot(freed.slot), setFreed(null))}>
                Pick food for {freed.slotLabel.split('–')[0]}
              </button>
            )}
            <button className="linkish" onClick={() => setFreed(null)}>
              Not now
            </button>
          </div>
        </div>
      )}

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
                <Ticket key={o.id} order={o} fresh={o.id === justPlaced} onCancel={() => cancel(o.id)} onPay={() => setPaying({ id: o.id, total: o.total })} />
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

          {usual.data && (
            <section className="usual area-usual" aria-label="Your usual">
              <div className="usual-pics" aria-hidden>
                {usual.data.items.slice(0, 3).map((i) => (
                  <img key={i.id} src={`/food/${i.id}.jpg`} alt="" />
                ))}
              </div>
              <div className="usual-copy">
                <span className="eyebrow">Your usual · ordered {usual.data.times} times</span>
                <div className="usual-name">
                  {usual.data.items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(' + ')}
                </div>
                <span className="small">at {usual.data.slotLabel}</span>
              </div>
              <button
                className="btn btn-dark usual-btn"
                disabled={busy || !usualOk}
                onClick={() => place(usual.data!.slot, usual.data!.items.map((i) => ({ id: i.id, qty: i.qty })))}
              >
                {usualOk ? `Order again · ${rupees(usual.data.total)}` : 'Sold out today'}
              </button>
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
                  disabled={Boolean(comboHit) || combo.data.items.some((c) => byId.get(c.id)?.available === false)}
                  onClick={() => combo.data!.items.forEach((c) => !qtyOf(c.id) && add(c.id))}
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
            {group && (
              <div className="who-bar" role="group" aria-label="Adding food for">
                <span className="small muted">Adding for:</span>
                {[ME, ...people].map((p) => (
                  <button key={p || 'me'} className="who-chip" aria-pressed={who === p} onClick={() => setWho(p)}>
                    {p || 'Me'}
                  </button>
                ))}
              </div>
            )}
            <div className="cats" role="group" aria-label="Category">
              {cats.map((c) => (
                <button key={c} className="chip" data-cat={c} aria-pressed={cat === c} onClick={() => setCat(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="menu">
              {shown.map((i) => {
                const q = qtyOf(i.id);
                const low = i.available && i.left != null && i.left <= 5;
                return (
                  <button
                    key={i.id}
                    className="item"
                    data-cat={i.category}
                    data-in={q > 0}
                    disabled={!i.available}
                    onClick={() => add(i.id)}
                    onPointerMove={tilt}
                    onPointerLeave={untilt}
                    aria-label={`Add ${i.name}, ${rupees(i.price)}${group ? ` for ${who || 'me'}` : ''}`}
                  >
                    {q ? <span className="qty">{q}</span> : null}
                    {low && <span className="left-tag">Only {i.left} left</span>}
                    <span className="photo" aria-hidden>
                      <img src={`/food/${i.id}.jpg`} alt="" loading="lazy" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
                      <span className="price-tag num">{i.available ? rupees(i.price) : i.soldOut === 'stock' ? 'Sold out today' : 'Not available'}</span>
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
                      {!i.available ? 'Sold out' : group ? `+ for ${who || 'me'}` : q ? '+ one more' : '+ Add'}
                    </span>
                  </button>
                );
              })}
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

            <div className="pick-me">
              <label className="small">
                My break
                <select value={brk.from} onChange={(e) => setBrk({ ...brk, from: e.target.value })}>
                  {allSlots.map((s) => (
                    <option key={s.slot} value={s.slot}>
                      {s.label.split('–')[0]}
                    </option>
                  ))}
                </select>
                to
                <select value={brk.to} onChange={(e) => setBrk({ ...brk, to: e.target.value })}>
                  {[...allSlots.slice(1).map((s) => s.slot), '15:00'].map((t) => (
                    <option key={t} value={t}>
                      {fmt12(t)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-sm btn-magic" onClick={pickForMe}>
                Pick for me
              </button>
            </div>
            {pickNote && <p className="small pick-note">{pickNote}</p>}
            {slots.data && !pickNote && <SlotHint slots={slots.data.slots} />}

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
                {refusal.slot && !waiting.some((w) => w.slot === refusal.slot) && (
                  <button className="btn btn-sm waitlist-btn" onClick={() => joinWaitlist(refusal.slot!)}>
                    Notify me if {fmt12(refusal.slot)} frees up
                  </button>
                )}
              </div>
            )}
            {waiting.length > 0 && (
              <div className="waitlist">
                {waiting.map((w) => (
                  <span key={w.slot} className="wait-chip">
                    {w.notified ? `A place opened at ${w.slotLabel.split('–')[0]}!` : `Waiting for ${w.slotLabel.split('–')[0]} · #${w.position} in line`}
                    <button aria-label={`Leave the waitlist for ${w.slotLabel}`} onClick={() => leaveWaitlist(w.slot)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="slots">
              {allSlots.map((s) => (
                <SlotButton key={s.slot} s={s} selected={slot === s.slot} onPick={() => (navigator.vibrate?.(10), setSlot(s.slot), setRefusal(null), setPickNote(null))} />
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
                <span>3</span> {group ? 'Group order' : 'Your order'}
              </h2>
              <span className="small muted">
                {count ? `${count} item${count > 1 ? 's' : ''}` : 'Nothing picked yet'}
                {pickedSlot ? ` · ${pickedSlot.label.split('–')[0]}` : ''}
              </span>
            </div>

            <div className="group-row">
              {!group ? (
                <span className="small muted">Ordering for friends too?</span>
              ) : (
                <div className="row wrap" style={{ gap: 6 }}>
                  {people.map((p) => (
                    <span key={p} className="friend-chip">
                      {p}
                      <button aria-label={`Remove ${p}`} onClick={() => removeFriend(p)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {people.length < 5 && (
                <form
                  className="add-friend"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addFriend();
                  }}
                >
                  <input className="input" placeholder="Friend's name" value={friendName} maxLength={30} onChange={(e) => setFriendName(e.target.value)} />
                  <button className="btn btn-sm" disabled={!friendName.trim()}>
                    + Add
                  </button>
                </form>
              )}
            </div>

            {count > 0 && (
              <div className="cart-lines">
                {[ME, ...people].map((p) => {
                  const mineLines = lines.filter((l) => l.person === p);
                  if (!mineLines.length) return null;
                  const sum = mineLines.reduce((s, l) => s + (byId.get(l.id)?.price ?? 0) * l.qty, 0);
                  return (
                    <div key={p || 'me'} className="person-block">
                      {group && (
                        <div className="person-head">
                          <strong>{p || 'Me'}</strong>
                          <span className="num">{rupees(sum)}</span>
                        </div>
                      )}
                      {mineLines.map((l) => {
                        const i = byId.get(l.id);
                        if (!i) return null;
                        return (
                          <div key={l.id} className="cart-line">
                            <img src={`/food/${i.id}.jpg`} alt="" />
                            <span className="grow">{i.name}</span>
                            <span className="stepper">
                              <button aria-label={`Remove one ${i.name}`} onClick={() => add(i.id, -1, p)}>
                                −
                              </button>
                              <span className="num">{l.qty}</span>
                              <button aria-label={`Add one ${i.name}`} onClick={() => add(i.id, 1, p)}>
                                +
                              </button>
                            </span>
                            <span className="num line-total">{rupees(i.price * l.qty)}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
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
                <div key={o.id} className="row between small recent-row">
                  <span>
                    #{o.token} · {o.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}
                  </span>
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setCart(Object.fromEntries(o.items.map((i) => [keyOf(ME, i.id), i.qty])));
                      setPeople([]);
                      setWho(ME);
                      document.querySelector('.area-slots')?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    Reorder
                  </button>
                </div>
              ))}
            </section>
          )}
          <div className="area-extra">
            <PhotoCredits />
          </div>
        </aside>
      </div>

      {paying && (
        <PaySheet
          orderId={paying.id}
          total={paying.total}
          user={user}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            mine.reload();
          }}
        />
      )}
    </main>
  );
}

function fmt12(t: string) {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
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
  // and its refusal carries the next free slot plus the waitlist offer.
  const unavailable = s.status === 'closed';
  const tag = s.status === 'closed' ? 'Passed' : s.status === 'full' ? 'Full' : s.quiet ? 'Quiet · no wait' : `${s.remaining} left`;
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

function Ticket({ order: o, fresh, onCancel, onPay }: { order: Order; fresh: boolean; onCancel: () => void; onPay: () => void }) {
  const now = useNow(15_000);
  const mins = minutesUntil(o.readyEta, now);
  const status =
    o.status === 'ready'
      ? 'Ready! Show your token at the counter.'
      : o.status === 'cooking'
        ? `Cooking now. Ready ${mins !== null && mins > 0 ? `in about ${mins} min` : 'any moment'}.`
        : `Ready at ${clock(o.readyEta)}${mins !== null && mins > 0 ? ` (in ${mins} min)` : ''}.`;
  const groups = new Map<string, { name: string; qty: number }[]>();
  for (const i of o.items) groups.set(i.for ?? '', [...(groups.get(i.for ?? '') ?? []), i]);
  const isGroup = groups.size > 1 || o.items.some((i) => i.for);
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
        {isGroup ? (
          <div className="split">
            {[...groups].map(([who, list]) => (
              <div key={who || 'me'} className="row between small">
                <span>
                  <strong>{who || 'Me'}</strong>: {list.map((i) => `${i.name} ×${i.qty}`).join(', ')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span className="small muted">{o.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}</span>
        )}
        <div className="row between wrap pay-row">
          <span className="small">
            <strong className="num">{rupees(o.total)}</strong>
            {o.discount > 0 ? <span className="muted"> (saved {rupees(o.discount)})</span> : null}
          </span>
          {o.payment === 'paid' ? (
            <span className="pill good">Paid</span>
          ) : o.payment === 'counter' ? (
            <span className="row" style={{ gap: 6 }}>
              <span className="pill warn">Pay at counter</span>
              <button className="btn btn-sm" onClick={onPay}>
                Pay by UPI
              </button>
            </span>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={onPay}>
              Pay now with UPI
            </button>
          )}
        </div>
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
