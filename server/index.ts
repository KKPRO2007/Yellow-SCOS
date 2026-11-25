import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const started = Date.now();
const { app, db } = await createApp();
app.listen(port, '0.0.0.0', () => {
  console.log(`Yellow API on http://localhost:${port}  (db: ${db.kind}, ready in ${Date.now() - started} ms)`);
});
