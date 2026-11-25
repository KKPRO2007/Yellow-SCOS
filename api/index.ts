// Vercel serverless entry: every /api/* request lands here (see vercel.json).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';

type App = Awaited<ReturnType<typeof createApp>>;
let ready: Promise<App> | null = null;

/**
 * Start once per instance. If startup fails (e.g. the database blipped), the
 * failure is not cached: the next request tries again, so one bad cold start
 * no longer makes the instance answer "offline" until Vercel recycles it.
 */
function boot(): Promise<App> {
  ready ??= createApp().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
boot().catch((err) => console.error('startup failed, will retry on next request:', err?.message ?? err));

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let app: App['app'];
  try {
    ({ app } = await boot());
  } catch (err) {
    console.error('startup failed:', (err as Error)?.message ?? err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '1');
    res.end(JSON.stringify({ error: 'STARTING', message: 'The server is starting up. Try again in a moment.' }));
    return;
  }
  return app(req as any, res as any);
}
