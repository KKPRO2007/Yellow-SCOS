import type { Request, Response } from 'express';
import type { Db } from './db.js';

// Server-sent events: every screen keeps one connection open and refetches
// when told something changed. Payloads carry no personal data.
//
// memory mode (one long-lived server): publish writes straight to the open
//   connections.
// db mode (serverless, e.g. Vercel): the instance that handles an order is
//   not the one holding the kitchen's connection, so publish appends to the
//   `events` table and every stream tails it.
export type Topic = 'slots' | 'orders' | 'menu' | 'settings' | 'stock';

const clients = new Set<Response>();
let db: Db | null = null;
let mode: 'memory' | 'db' = 'memory';
const POLL_MS = 1500;
const MAX_STREAM_MS = 280_000; // end cleanly before the platform's function timeout

export function initEvents(database: Db, useDb: boolean) {
  db = database;
  mode = useDb ? 'db' : 'memory';
}

export function stream(req: Request, res: Response) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: 2000\n\n`);
  const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
  const timers: ReturnType<typeof setInterval>[] = [ping];

  if (mode === 'memory' || !db) {
    clients.add(res);
  } else {
    const d = db;
    let last = Number(req.headers['last-event-id']) || 0;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!last) {
          const [r] = await d.query<{ id: string }>(`SELECT COALESCE(MAX(id), 0) AS id FROM events`);
          last = Number(r.id);
        } else {
          const rows = await d.query<{ id: string; topic: string; data: string }>(
            `SELECT id, topic, data FROM events WHERE id > $1 ORDER BY id LIMIT 200`,
            [last],
          );
          for (const r of rows) {
            res.write(`id: ${r.id}\nevent: ${r.topic}\ndata: ${r.data}\n\n`);
            last = Number(r.id);
          }
        }
      } catch {
        /* transient DB hiccup: try again next tick */
      } finally {
        busy = false;
      }
    };
    tick();
    timers.push(setInterval(tick, POLL_MS));
    timers.push(setTimeout(() => res.end(), MAX_STREAM_MS) as unknown as ReturnType<typeof setInterval>);
  }

  req.on('close', () => {
    timers.forEach((t) => clearInterval(t));
    clients.delete(res);
  });
}

export function publish(topic: Topic, data: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ ...data, at: Date.now() });
  if (mode === 'db' && db) {
    const d = db;
    return d
      .query(`INSERT INTO events (topic, data) VALUES ($1, $2)`, [topic, payload])
      .then(() => (Math.random() < 0.02 ? d.query(`DELETE FROM events WHERE at < now() - interval '2 hours'`) : null))
      .catch((err) => console.error('publish failed', err));
  }
  const msg = `event: ${topic}\ndata: ${payload}\n\n`;
  for (const c of clients) c.write(msg);
  return Promise.resolve();
}
