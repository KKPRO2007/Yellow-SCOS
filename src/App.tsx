import { useEffect, useState, type FormEvent } from 'react';
import { api, auth, useConnected, type User } from './api';
import { Buyer } from './Buyer';
import { Kitchen } from './Kitchen';
import { Admin } from './Admin';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(auth.token));

  useEffect(() => {
    if (!auth.token) return;
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => auth.set(null))
      .finally(() => setChecking(false));
  }, []);

  const signIn = (token: string, u: User) => {
    auth.set(token);
    setUser(u);
  };
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    auth.set(null);
    setUser(null);
  };

  if (checking) return null;
  if (!user) return <Login onSignIn={signIn} />;
  return <Shell user={user} onSignOut={signOut} />;
}

type View = 'order' | 'kitchen' | 'overview' | 'stock' | 'money' | 'settings';
const VIEWS: Record<User['role'], { id: View; label: string }[]> = {
  buyer: [{ id: 'order', label: 'Order' }],
  seller: [{ id: 'kitchen', label: 'Kitchen' }],
  admin: [
    { id: 'overview', label: 'Overview' },
    { id: 'stock', label: 'Stock' },
    { id: 'money', label: 'Money' },
    { id: 'kitchen', label: 'Kitchen' },
    { id: 'settings', label: 'Settings' },
  ],
};

// Simple line icons for the phone tab bar (24px, currentColor).
const ICONS: Record<View, string> = {
  order: 'M4 7h16l-1.5 11a2 2 0 0 1-2 1.7H7.5a2 2 0 0 1-2-1.7L4 7Zm4 0a4 4 0 0 1 8 0',
  kitchen: 'M6 10h12v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8Zm-2 0h16M9 6c0-1 1-1 1-2m3 2c0-1 1-1 1-2',
  overview: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  stock: 'M4 8l8-4 8 4-8 4-8-4Zm0 0v8l8 4 8-4V8M12 12v8',
  money: 'M3 7h18v10H3V7Zm9 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6 10v4m12-4v4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** "Install app" appears when the browser offers it (Android/desktop Chrome, Edge). */
function useInstall() {
  const [prompt, setPrompt] = useState<any>(null);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', h);
    window.addEventListener('appinstalled', () => setPrompt(null));
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  return prompt
    ? async () => {
        prompt.prompt();
        await prompt.userChoice.catch(() => null);
        setPrompt(null);
      }
    : null;
}

function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const views = VIEWS[user.role];
  const [view, setView] = useState<View>(views[0].id);
  const connected = useConnected();
  const install = useInstall();
  const go = (v: View) => {
    if (v === view) return window.scrollTo({ top: 0, behavior: 'smooth' });
    navigator.vibrate?.(8);
    setView(v);
    window.scrollTo({ top: 0 });
  };
  return (
    <div className={`shell ${views.length > 1 ? 'has-bottomnav' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            Y
          </span>
          <span>Yellow</span>
        </div>
        {views.length > 1 && (
          <div className="tabs top-tabs" role="tablist">
            {views.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => go(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        {install && (
          <button className="btn btn-sm btn-primary" onClick={install}>
            Install app
          </button>
        )}
        <span className={`live-dot ${connected ? '' : 'down'}`} title={connected ? 'Live updates on' : 'Reconnecting…'}>
          {connected ? 'Live' : 'Offline'}
        </span>
        <button className="btn btn-ghost btn-sm signout" onClick={onSignOut} title={`${user.email} · sign out`}>
          <span className="avatar" aria-hidden>
            {user.name[0]}
          </span>
          <span className="signout-text">{user.name.split(' ')[0]} · Sign out</span>
        </button>
      </header>
      <div className="view" key={view}>
        {view === 'order' && <Buyer user={user} />}
        {view === 'kitchen' && <Kitchen user={user} />}
        {(view === 'overview' || view === 'stock' || view === 'money' || view === 'settings') && <Admin section={view} />}
      </div>
      {views.length > 1 && (
        <nav className="bottomnav" aria-label="Sections">
          {views.map((v) => (
            <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => go(v.id)}>
              <Icon d={ICONS[v.id]} />
              <span>{v.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

const DEMOS = [
  { role: 'Student', who: 'Krishna', what: 'Order in 3 taps', email: 'buyer@demo.test', tone: 'student' },
  { role: 'Kitchen', who: 'Canteen staff', what: 'Cook next & alerts', email: 'seller@demo.test', tone: 'kitchen' },
  { role: 'Shopkeeper', who: 'Admin', what: 'Stock, money, AI', email: 'admin@demo.test', tone: 'admin' },
];
const HERO_FOOD = ['samosa', 'masala-dosa', 'chai', 'veg-thali', 'gulab-jamun', 'vada-pav'];

function Login({ onSignIn }: { onSignIn: (token: string, u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent, override?: { email: string; password: string }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = override ?? (mode === 'login' ? { email, password } : { name, email, password });
      const r = await api<{ token: string; user: User }>(mode === 'login' || override ? '/auth/login' : '/auth/register', { body });
      onSignIn(r.token, r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-split">
      <section className="login-hero" aria-hidden>
        <div className="float-field">
          {HERO_FOOD.map((id, k) => (
            <div key={id} className={`float-card g${k}`}>
              <img src={`/food/${id}.jpg`} alt="" />
            </div>
          ))}
        </div>
        <div className="login-hero-copy">
          <div className="word3d">Yellow</div>
          <p className="hero-sub">Rush hour, without the rush. Pre-order campus food, pick a 15-minute pickup slot, skip the queue.</p>
          <div className="hero-stats">
            <div>
              <strong>0 min</strong>
              <span>in the queue</span>
            </div>
            <div>
              <strong>15 min</strong>
              <span>pickup slots</span>
            </div>
            <div>
              <strong>Live</strong>
              <span>kitchen sync</span>
            </div>
          </div>
        </div>
      </section>
      <div className="login-side">
      <div className="login-card stack">
        <div className="brand" style={{ fontSize: 22 }}>
          <span className="brand-mark" aria-hidden>
            Y
          </span>
          Yellow
        </div>
        <h1>Welcome back</h1>
        <p className="muted">Pick a demo account to jump in, or sign in below.</p>

        <div className="role-cards">
          {DEMOS.map((d) => (
            <button key={d.email} className="role-card" data-tone={d.tone} disabled={busy} onClick={(e) => submit(e, { email: d.email, password: 'demo1234' })}>
              <span className="role-name">{d.role}</span>
              <span className="role-who">{d.who}</span>
              <span className="role-what">{d.what}</span>
            </button>
          ))}
        </div>
        <span className="small faint">All demo accounts use the password demo1234.</span>

        <form className="card stack" onSubmit={submit}>
          <div className="row between">
            <h2>{mode === 'login' ? 'Sign in' : 'Create a student account'}</h2>
            <button type="button" className="linkish" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'New here?' : 'Have an account?'}
            </button>
          </div>
          {mode === 'register' && (
            <label className="field">
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          )}
          <label className="field">
            Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="field">
            Password
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={6}
              required
            />
          </label>
          {error && <div className="notice bad small">{error}</div>}
          <button className="btn btn-primary btn-block btn-3d" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
      </div>
    </div>
  );
}
