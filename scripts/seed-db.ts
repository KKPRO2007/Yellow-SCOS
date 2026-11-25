// Create the schema and load 30 days of fake orders into DATABASE_URL (Neon).
//   npm run db:seed
import 'dotenv/config';
import { SCHEMA, connect } from '../server/db.js';
import { seedToday } from '../server/ordering.js';
import { seed } from '../server/seed.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (put the Neon pooled connection string in .env).');
  process.exit(1);
}
const t0 = Date.now();
const db = await connect();
await db.exec(SCHEMA);
await seed(db);
const today = await seedToday(db);
const [c] = await db.query<{ users: number; items: number; orders: number; days: number; lines: number }>(
  `SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM menu_items)::int AS items,
          (SELECT COUNT(*) FROM orders)::int AS orders, (SELECT COUNT(DISTINCT service_date) FROM orders)::int AS days,
          (SELECT COUNT(*) FROM order_items)::int AS lines`,
);
console.log(`Neon ready in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, c, `(+${today} sample bookings today)`);
await db.close();
