// All canteen times are local wall-clock times. India has no DST, so a fixed
// offset is exact; override TZ_OFFSET_MIN for another campus.
const OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN ?? 330);

export const OPEN_MIN = 11 * 60; // 11:00
export const CLOSE_MIN = 15 * 60; // 15:00
export const SLOT_LEN = 15;

export const SLOT_STARTS: string[] = [];
for (let m = OPEN_MIN; m < CLOSE_MIN; m += SLOT_LEN) SLOT_STARTS.push(hhmm(m));

export const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Local date (YYYY-MM-DD) and minutes since local midnight. */
export function localNow(d = new Date()): { date: string; minutes: number } {
  const shifted = new Date(d.getTime() + OFFSET_MIN * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export function dowOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Canteen is closed on Sundays. */
export function isOperating(date: string): boolean {
  return dowOf(date) !== 0;
}

export function nextOperatingDays(from: string, count: number, includeFrom = true): string[] {
  const out: string[] = [];
  let d = includeFrom ? from : addDays(from, 1);
  while (out.length < count) {
    if (isOperating(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** Local date + HH:MM (+ extra minutes) -> real instant. */
export function localToDate(date: string, minutes: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + (minutes - OFFSET_MIN) * 60_000);
}

export function slotLabel(start: string): string {
  return `${fmt12(toMin(start))}–${fmt12(toMin(start) + SLOT_LEN)}`;
}

export function fmt12(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
