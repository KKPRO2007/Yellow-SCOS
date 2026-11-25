# Prompt log

What we asked the AI, and what it got wrong. Add to this as you go; the pitch needs one good example.

| # | Who | Prompt (short) | What the AI got wrong | Fix |
|---|---|---|---|---|
| 1 | Product lead | Break the brief into layers and agree an API contract | — | Contract is in README → API |
| 2 | Data analyst | Generate 30 days of realistic canteen orders with a lunch peak | The first combo of the day was "Cutting Chai + Samosa", treating chai as the main item because it sells most | The main item is now the pricier one: "Samosa + Chai, 45% attach" |
| 3 | Backend | Atomic slot booking that never overbooks | A test assumed today's slots start empty, but the app pre-fills them with sample bookings (an ES-module import-order trap), so 24 ≠ 30 | Tests count the free places that are actually left |
| 4 | Creative UI | Disable full slots in the picker | That would have failed the gate: the judge must be able to *try* the full slot and see the server refuse it | Full slots stay tappable; the 409 carries the next slot and offers it in one tap |
| 5 | Backend | LLM briefing via Groq | The default model `llama-3.3-70b-versatile` no longer exists on the account; strict schema checks rejected otherwise good answers | Listed the account's models and defaulted to `openai/gpt-oss-120b`; the parser now coerces types and trims lists |
| 6 | Backend | LLM briefing via Gemini | `gemini-flash-latest` returned 503 "high demand" at peak | Retry once, then fall back to `gemini-2.5-flash` and `gemini-flash-lite-latest`, then rules |
| 7 | UI | Real food photos | Wikipedia's "Maggi" image is the brand logo; "Biryani" was a chicken dum biryani on a menu item marked veg; "cold coffee" came back as an affogato | Picked CC-licensed Commons photos by hand, checked each by eye, and credited them in the app |
| 8 | Backend | Live updates on Vercel | In-memory server-sent events only reach clients on the same instance; serverless has many | Events go through a Postgres `events` table that each stream tails |

## Best prompt (for the pitch)

> "Fill the 1:00 pm slot, then book one more. What does the student see?"

This made us notice that a disabled "Full" button would hide the gate entirely. The server has to be the one that says no, and its answer must carry the next slot.
