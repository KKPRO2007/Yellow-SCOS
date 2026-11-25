import { useCallback, useEffect, useRef, useState } from 'react';

export type Role = 'buyer' | 'seller' | 'admin';
export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
}
export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
  prepMinutes: number;
  veg: boolean;
  available: boolean;
  manualAvailable?: boolean;
  /** portions the live stock can still make (null = not tracked) */
  left?: number | null;
  soldOut?: 'manual' | 'stock' | null;
}
export interface Slot {
  slot: string;
  label: string;
  capacity: number;
  booked: number;
  remaining: number;
  fill: number;
  status: 'open' | 'busy' | 'full' | 'closed';
  forecastOrders: number;
  quiet: boolean;
}
export interface Order {
  id: number;
  token: number;
  slot: string;
  slotLabel: string;
  date: string;
  status: 'placed' | 'cooking' | 'ready' | 'collected' | 'cancelled';
  total: number;
  discount: number;
  readyEta: string | null;
  readyAt: string | null;
  placedAt: string;
  customer: string | null;
  payment: 'unpaid' | 'paid' | 'counter';
  items: { id: string; name: string; qty: number; for: string | null }[];
}
export interface Combo {
  items: { id: string; name: string; price: number }[];
  price: number;
  fullPrice: number;
  reason: string;
}

const TOKEN_KEY = 'yellow.token';
export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string | null) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = auth.token;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? `Request failed (${res.status})`, body);
  return body as T;
}

// ---------------------------------------------------------------- live data

type Topic = 'slots' | 'orders' | 'menu' | 'settings' | 'stock';
export interface LiveEvent {
  kind?: 'new' | 'status' | 'paid' | 'waitlist' | 'low' | 'restock';
  userId?: number;
  low?: { name: string; onHand: number; unit: string }[];
  id?: number;
  token?: number;
  slot?: string;
  slotLabel?: string;
  status?: string;
  items?: { id: string; name: string; qty: number; for?: string | null }[];
}
const listeners = new Map<Topic, Set<(e: LiveEvent) => void>>();
let source: EventSource | null = null;
const connListeners = new Set<(up: boolean) => void>();

let lastId = '';
let downSince = 0;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
const ALL: Topic[] = ['slots', 'orders', 'menu', 'settings', 'stock'];

function setUp(up: boolean) {
  connListeners.forEach((fn) => fn(up));
}

/**
 * One live connection for the whole app. Serverless hosts end streams every
 * few minutes; that is normal, so we reconnect at once from the last event
 * seen and only call it "offline" if we stay disconnected for 6 seconds.
 * After a real outage every screen refetches, so nothing missed stays stale.
 */
function ensureStream() {
  if (source) return;
  source = new EventSource(`/api/stream${lastId ? `?last=${encodeURIComponent(lastId)}` : ''}`);
  for (const t of ALL)
    source.addEventListener(t, (ev) => {
      const me = ev as MessageEvent;
      if (me.lastEventId) lastId = me.lastEventId;
      let data: LiveEvent = {};
      try {
        data = JSON.parse(me.data);
      } catch {
        /* ignore */
      }
      listeners.get(t)?.forEach((fn) => fn(data));
    });
  source.addEventListener('bye', () => reopen(0));
  source.onopen = () => {
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = null;
    if (downSince && Date.now() - downSince > 3000) ALL.forEach((t) => listeners.get(t)?.forEach((fn) => fn({})));
    downSince = 0;
    setUp(true);
  };
  source.onerror = () => {
    if (!downSince) downSince = Date.now();
    offlineTimer ??= setTimeout(() => setUp(false), 6000);
    // The browser retries by itself while CONNECTING; if it gave up, we retry.
    if (source?.readyState === EventSource.CLOSED) reopen(2000);
  };
}

function reopen(delay: number) {
  source?.close();
  source = null;
  setTimeout(ensureStream, delay);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => reopen(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!source || source.readyState === EventSource.CLOSED)) reopen(0);
  });
}

export function useConnected() {
  const [up, setUp] = useState(true);
  useEffect(() => {
    ensureStream();
    connListeners.add(setUp);
    return () => void connListeners.delete(setUp);
  }, []);
  return up;
}

/** Fetches `path`, and refetches whenever the server says one of `topics` changed. */
export function useLive<T>(path: string | null, topics: Topic[], pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try {
      const d = await api<T>(path);
      if (n === seq.current) (setData(d), setError(null));
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    load();
    ensureStream();
    // Bursts of events (a judge hammering "book") collapse into one refetch.
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 150);
    };
    for (const t of topics) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(onEvent);
    }
    const poll = pollMs ? setInterval(load, pollMs) : null;
    return () => {
      for (const t of topics) listeners.get(t)?.delete(onEvent);
      if (poll) clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, topics.join(',')]);

  return { data, error, reload: load, setData };
}

/** Calls `fn` for every live event on `topic`. */
export function useEvent(topic: Topic, fn: (e: LiveEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensureStream();
    const h = (e: LiveEvent) => ref.current(e);
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic)!.add(h);
    return () => void listeners.get(topic)?.delete(h);
  }, [topic]);
}

/** Short two-tone chime, no audio file needed. */
export function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new Ctx();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.15);
      o.stop(ctx.currentTime + i * 0.15 + 0.32);
    });
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio blocked until the user interacts; fine */
  }
}

export function notify(title: string, body: string) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
}

/** Re-renders every `ms` so countdowns stay fresh. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function clock(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function minutesUntil(iso: string | null, now = Date.now()) {
  return iso ? Math.round((Date.parse(iso) - now) / 60_000) : null;
}
