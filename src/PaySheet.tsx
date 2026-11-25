import { useEffect, useState } from 'react';
import { api, rupees, type User } from './api';

interface PayInfo {
  mode: 'razorpay' | 'test';
  amount: number; // rupees in test mode, paise for razorpay
  token: number;
  keyId?: string;
  rzpOrderId?: string;
  prefill?: { name: string; email: string };
}

const APPS = [
  { id: 'gpay', name: 'Google Pay', tone: '#1a73e8' },
  { id: 'phonepe', name: 'PhonePe', tone: '#5f259f' },
  { id: 'paytm', name: 'Paytm', tone: '#00b9f1' },
  { id: 'bhim', name: 'BHIM UPI', tone: '#f47b20' },
];

function loadRazorpay(): Promise<any> {
  const w = window as any;
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(w.Razorpay);
    s.onerror = () => reject(new Error('Could not load Razorpay checkout.'));
    document.head.appendChild(s);
  });
}

/**
 * Bottom sheet to pay for one order by UPI. With Razorpay keys on the server
 * it opens the real Razorpay checkout; otherwise it runs a labelled test flow
 * in which no money moves.
 */
export function PaySheet({ orderId, total, user, onClose, onDone }: { orderId: number; total: number; user: User; onClose: () => void; onDone: (how: 'paid' | 'counter') => void }) {
  const [info, setInfo] = useState<PayInfo | null>(null);
  const [app, setApp] = useState('gpay');
  const [stage, setStage] = useState<'choose' | 'approving' | 'done'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [txn, setTxn] = useState<string | null>(null);
  const appName = APPS.find((a) => a.id === app)!.name;
  const STEPS = [`Opening ${appName}`, 'Payment request sent', `Approved in ${appName}`, 'Verifying with bank'];

  useEffect(() => {
    api<PayInfo>(`/orders/${orderId}/pay`, { method: 'POST' })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [orderId]);

  async function pay() {
    if (!info) return;
    setError(null);
    if (info.mode === 'razorpay') {
      try {
        const Razorpay = await loadRazorpay();
        const rzp = new Razorpay({
          key: info.keyId,
          order_id: info.rzpOrderId,
          amount: info.amount,
          currency: 'INR',
          name: 'Yellow Canteen',
          description: `Order #${info.token}`,
          prefill: { name: info.prefill?.name ?? user.name, email: info.prefill?.email ?? user.email },
          method: { upi: true },
          theme: { color: '#ffb21e' },
          handler: async (resp: Record<string, string>) => {
            try {
              await api(`/orders/${orderId}/pay/confirm`, { body: resp });
              setStage('done');
              navigator.vibrate?.([20, 60, 30]);
              setTimeout(() => onDone('paid'), 1200);
            } catch (e) {
              setError((e as Error).message);
            }
          },
        });
        rzp.on('payment.failed', (r: { error?: { description?: string } }) => setError(r.error?.description ?? 'Payment failed.'));
        rzp.open();
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    // Demo gateway: walk through what a real UPI payment looks like.
    setStage('approving');
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let k = 0; k < STEPS.length; k++) {
      setStep(k);
      await wait([700, 600, 1000, 800][k]);
    }
    try {
      await api(`/orders/${orderId}/pay/confirm`, { body: { test: true } });
      setTxn(`UPI${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 90 + 10)}`);
      setStage('done');
      navigator.vibrate?.([20, 60, 30]);
      setTimeout(() => onDone('paid'), 1200);
    } catch (e) {
      setStage('choose');
      setError((e as Error).message);
    }
  }

  async function counter() {
    await api(`/orders/${orderId}/pay-at-counter`, { method: 'POST' }).catch(() => {});
    onDone('counter');
  }

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && stage !== 'approving' && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Pay with UPI">
        <div className="sheet-grip" aria-hidden />
        {stage === 'done' ? (
          <div className="pay-done">
            <div className="tick" aria-hidden>
              ✓
            </div>
            <h2>Paid {rupees(total)}</h2>
            <p className="muted">Your order is confirmed. Just show your token at the counter.</p>
            {txn && (
              <div className="receipt small">
                <span>
                  Paid via <strong>{appName}</strong>
                </span>
                <span>
                  Transaction ID <strong className="mono">{txn}</strong>
                </span>
                <span>To Yellow Canteen · {new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>
              </div>
            )}
          </div>
        ) : stage === 'approving' ? (
          <div className="pay-progress" aria-live="polite">
            <div className="spinner" aria-hidden />
            <div className="pay-amount num">{rupees(total)}</div>
            <ol className="pay-steps">
              {STEPS.map((s, k) => (
                <li key={s} data-state={k < step ? 'done' : k === step ? 'now' : 'todo'}>
                  <span className="dot" aria-hidden>
                    {k < step ? '✓' : ''}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
            <span className="small faint">Don't close this screen</span>
          </div>
        ) : (
          <>
            <div className="row between">
              <div>
                <span className="section-label">Pay for order {info ? `#${info.token}` : ''}</span>
                <div className="pay-amount num">{rupees(total)}</div>
              </div>
              {info?.mode === 'test' && <span className="pill plain demo-pill">Demo</span>}
              {info?.mode === 'razorpay' && <span className="pill good">Razorpay</span>}
            </div>
            <p className="small muted">Pay to Yellow Canteen · secure UPI</p>
            <div className="upi-apps" role="radiogroup" aria-label="UPI app">
              {APPS.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={app === a.id}
                  className="upi-app"
                  style={{ ['--tone' as string]: a.tone }}
                  onClick={() => setApp(a.id)}
                 
                >
                  <span className="upi-dot" aria-hidden>
                    {a.name[0]}
                  </span>
                  {a.name}
                </button>
              ))}
            </div>
            {error && <div className="notice bad small">{error}</div>}
            <button className="btn btn-primary btn-block btn-3d" disabled={!info} onClick={pay}>
              {`Pay ${rupees(total)} with UPI`}
            </button>
            <button className="linkish" style={{ alignSelf: 'center' }} onClick={counter}>
              Pay at the counter instead
            </button>
          </>
        )}
      </div>
    </div>
  );
}
