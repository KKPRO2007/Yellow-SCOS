# Yellow — Rush Hour: handoff

## Problem statement (from Downloads/GLA-Yellow.docx)

**YELLOW — Rush Hour.** Your mission: kill the canteen queue. Nobody should lose half their lunch break waiting for a samosa.

**The situation:** At 1 pm, 400 students reach a canteen with one counter. Half of them wait 15 minutes, some give up, and the kitchen still runs out of the popular items while the others go to waste.

**What you are building**

| Layer | It must |
|---|---|
| Data | Generate 30 days of realistic orders: item, time, quantity, price. Find the peak 15-minute slots and the top 5 items by day of the week. |
| Backend API | Serve the menu, place an order with a pickup slot, refuse a slot once it is full, and list orders for the kitchen. |
| Creative UI | A student orders in 3 taps and gets a pickup time. The kitchen sees what to cook next. |

**Levels**
- Level 1, to qualify: a student places an order in the UI, the API gives a pickup slot, and the order appears on the kitchen screen.
- Level 2: slots fill up and close, and the busiest slots are shown so students pick a quieter one.
- Level 3, your twist: "cook ahead" suggestions from your data, a live queue meter, a combo of the day, or something better.

**Your team**

| Role | Uses AI to |
|---|---|
| Product lead and integrator | Break the problem down, agree the API contract in the first 15 minutes, wire the layers together |
| Data analyst | Generate the sample data and pull out the insights |
| Backend developer | Generate the API and the slot logic |
| Creative UI designer | Generate the interface and make it a joy to use |
| Quality and pitch lead | Test edge cases, keep the prompt log, build the 3-minute pitch |

**Rules:** Any language, framework and AI tool. Your data must be fake: no real names or numbers. Keep a prompt log of what you asked and what the AI got wrong.

**The gate at 90 minutes:** The judge books orders until the 1:00 to 1:15 pm slot is full, then tries one more. Your app must refuse it and offer the next slot.

**Your 3-minute pitch:** Give one data insight, a live end-to-end demo, and your best prompt with what the AI got wrong.

## Decisions made with the user

- Repo: `C:/Users/kkpro/orca/Yellow-SCOS` (empty `main`, nothing committed yet).
- Stack: React + Vite + TypeScript (UI), Express + TypeScript via `tsx` (API).
- DB: Neon PostgreSQL via `DATABASE_URL`; without it, PGlite (in-process Postgres) — set `PGLITE_DIR=./data/pglite` to persist locally.
- UI: clean utility look, neutral + one yellow accent, mobile-first, no AI-slop (no gradients/emoji/glass).
- 3 roles: **buyer** (student), **seller** (canteen staff / kitchen), **admin** (shopkeeper).
- Extras: cook-ahead, live queue meter, combo of the day, insights dashboard, ML demand forecast (improves with more data), LLM briefing (Claude, with rule-based fallback).
- Live sync across devices via server-sent events (`/api/stream`).
- Ready time ("when will my order be ready") shown per order.

## Done (server, untested — first boot was interrupted)

| File | What |
|---|---|
| `server/time.ts` | IST time helpers, 16 slots 11:00–15:00 |
| `server/db.ts` | Neon/pg or PGlite adapter + schema |
| `server/seed.ts` | menu, 30 operating days of fake orders, demo users, settings |
| `server/auth.ts` | scrypt passwords, bearer sessions, `requireRole` |
| `server/ml.ts` | ridge regression forecast, backtest vs baselines, learning curve |
| `server/analytics.ts` | peak slots, top 5 by weekday, queue sim, forecasts, today's slot plan, combo |
| `server/ordering.ts` | atomic slot booking (409 + next slot when full), ready ETA, status flow, demo pre-fill |
| `server/ai.ts` | Claude briefing (`claude-opus-5-5`, structured output) + rules fallback |
| `server/events.ts` | SSE publish/subscribe |
| `server/app.ts`, `server/index.ts` | all routes, serves `dist/` in production |
| `scripts/smoke.ts` | quick boot + data check: `npx tsx scripts/smoke.ts` |

Demo logins (password `demo1234`): `buyer@demo.test`, `seller@demo.test`, `admin@demo.test`.

### API
- `POST /api/auth/login | /register | /logout`, `GET /api/auth/me`
- `GET /api/menu`, `GET /api/slots`, `GET /api/combo`, `GET /api/stream` (public)
- buyer: `POST /api/orders {slot, items:[{id,qty}]}` → 201, or **409 `SLOT_FULL` with `nextSlot` + `alternatives`**; `GET /api/orders/mine`; `POST /api/orders/:id/cancel`
- seller/admin: `GET /api/kitchen`, `PATCH /api/orders/:id/status`, `PATCH /api/menu/:id {available}`
- admin: `GET /api/insights`, `POST /api/ai/briefing`, `GET|PATCH /api/admin/settings`, `GET|POST /api/admin/staff`, `POST /api/admin/reset-today`

## To do next
1. Run `npx tsx scripts/smoke.ts`; fix boot/type errors (`npm run typecheck`).
2. `vite.config.ts` (proxy `/api` → `http://localhost:8787`), `index.html`, `src/` React app:
   login, buyer (menu → slot → place, my orders with live ETA), seller (kitchen board, cook ahead, sold-out toggles), admin (insights charts, forecast, AI briefing, settings, staff).
3. `test/gate.test.ts`: fill 13:00 slot, next booking must 409 with `nextSlot = 13:15`.
4. `scripts/export-data.ts` → `data/orders.csv` for the data analyst (`historyCsv` in `seed.ts`).
5. `.env.example`, `README.md`, `PROMPT_LOG.md`.
