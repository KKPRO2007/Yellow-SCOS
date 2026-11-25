# Yellow — Rush Hour

Kill the canteen queue. Students order in three taps and get a pickup slot and a ready time. The kitchen sees what to cook next. The shopkeeper sees demand, stock and money. All of the data is fake.

## Run it

```bash
npm install
npm run dev            # API on :8787 + UI on :5173 (opens on your LAN too)
```

Open http://localhost:5173. Demo logins (password `demo1234`), with a one-tap button for each on the login screen:

| Role | Email | Sees |
|---|---|---|
| Student (Krishna) | `buyer@demo.test` | menu → slot → place; live token + ready time |
| Kitchen | `seller@demo.test` | cook-next, order board by slot, cook-ahead, sold-out toggles, new-order alerts |
| Shopkeeper | `admin@demo.test` | overview, stock & forecast, money, kitchen, settings, staff |

With no `.env` the app uses an in-process Postgres (PGlite) and the rule-based briefing. See `.env.example` for Neon and the LLM keys.

## The three layers

**Data.** 30 operating days (Mon–Sat) of fake orders for 13 items, about 470 a day. The generator models a lunch peak around 1:05 pm, an 11:30 tea break and weekday effects: dosa on Monday, chole on Wednesday, biryani on Friday, a slow Saturday. It adds add-on habits like chai with a samosa, plus a sports day and a fest day. `npm run data` writes `data/orders.csv` and `data/summary.json` for the data analyst.
- Peak slots: 1:00–1:15 pm (~75 orders/day), 12:45–1:00 pm (~69), 1:15–1:30 pm (~66), against a counter that serves 30 per slot.
- The top 5 items differ by weekday (Overview tab).

**API.** Express + Postgres.
- `GET /api/menu`, `GET /api/slots`, `GET /api/combo`, `GET /api/stream` (live events)
- `POST /api/orders {slot, items:[{id,qty}]}` returns `201` with a token and a ready time, or **`409 SLOT_FULL` with `nextSlot` and `alternatives`**
- `GET /api/orders/mine`, `POST /api/orders/:id/cancel`
- Kitchen: `GET /api/kitchen`, `PATCH /api/orders/:id/status`, `PATCH /api/menu/:id`
- Shopkeeper: `GET /api/insights`, `POST /api/ai/briefing`, `GET|PATCH /api/admin/settings`, `GET|POST /api/admin/staff`, `POST /api/admin/reset-today`

A slot place is taken with one conditional `UPDATE … WHERE booked < capacity`, so two buyers can never both get the last place. `npm test` covers the gate, a 45-order concurrent burst and bad input.

**UI.** React + Vite. Mobile first: one yellow accent, real food photos (Wikimedia Commons, credited in the app).

## The gate

The judge fills 1:00–1:15 pm, then tries one more. Full slots stay tappable on purpose, so the server is what refuses. The refusal reads "1:00 pm–1:15 pm is full. Next free slot: 1:15 pm–1:30 pm." and offers a one-tap **Book 1:15 pm–1:30 pm instead**. Tip: Settings → *Reset today empty* gives a clean board, and *Orders per slot* can be lowered to make filling quick.

## Level 3 extras

- **Cook ahead.** For each of the next four slots: max(booked, forecast) per item.
- **Live queue meter.** Fill of the counter's current slot, and quiet slots marked "no wait".
- **Combo of the day.** The pair most often bought together on this weekday, 10% off, applied automatically.
- **ML forecast.** A ridge regression per item on weekday, trend and last week. It is backtested on the held-out last week against "same as last week" and "average of last week". A learning curve shows the error falling as days of data grow. App orders become training data the next day.
- **Stock plan.** Item forecast (80% upper range) × recipes gives the raw ingredients to buy today, tomorrow and this week.
- **LLM briefing and stock advice.** Gemini, then Groq, then Claude, then rules. The LLM only reads numbers the code computed, and its reply is parsed into a fixed shape.
- **Money.** Revenue, food cost, gross profit and margin per day and per item. Food cost is editable.
- **Alerts.** The kitchen gets a chime, a toast and a system notification for new orders. Students get one when their order is ready.
- Live sync to every screen through server-sent events. On Vercel these are backed by an `events` table so every instance sees them.

## Product features

- **UPI payment**: a payment sheet opens after placing an order. It runs in test mode (no money moves) until `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set; then it opens the real Razorpay checkout and verifies the signature on the server. Students can also choose *pay at the counter*; the kitchen sees *Paid by UPI* or *Collect ₹X*.
- **Waitlist**: when a slot is full, the student taps *Notify me if it frees up*. A cancel in that slot alerts the first student waiting (in-app banner, sound, vibration, system notification), and they can book in one tap.
- **Pick for me**: the student sets a class break and the app picks the quietest open slot inside it.
- **Your usual**: the student's most frequent order and slot from their history, reordered in one tap. Any past order also has *Reorder*.
- **Group order**: add up to 5 friends, add food per person, and see a split bill. The kitchen sees *for Rahul* on each line.
- **Live stock**: every order uses up ingredients by recipe (checked atomically, so stock never goes negative). Cancels return them. Items sell out on their own, show *Only N left*, and trigger low-stock alerts in the kitchen. The shopkeeper logs the morning delivery and gets an **AI purchase order** (quantities from the forecast; Gemini or Groq writes the supplier message, ready to copy or send on WhatsApp).

## Deploy (Neon + Vercel)

```bash
# 1. put the Neon *pooled* connection string in .env as DATABASE_URL
npm run db:seed                     # schema + 30 days of orders + demo users
# 2. Vercel
vercel link
vercel env add DATABASE_URL production   # and GEMINI_API_KEY, GROQ_API_KEY
vercel deploy --prod
```

`api/index.ts` wraps the Express app as one serverless function, and `vercel.json` routes `/api/*` to it while the rest serves the built UI. On boot the server tops history up to yesterday, so the demo keeps 30 fresh days.

## Layout

```
server/   time, db (Neon or PGlite), seed (fake data, recipes), auth, ordering (slots),
          analytics (peaks, top 5, combo, stock, money), ml (ridge + backtest), ai, events, app
src/      App (login, roles), Buyer, Kitchen, Admin, charts, api
api/      Vercel entry
scripts/  smoke.ts, seed-db.ts, export-data.ts
test/     gate.test.ts
```
