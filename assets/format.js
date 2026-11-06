// Date and number formatting shared by the page, the storyline rules and the
// snapshot builder. Every time is shown in Pittsburgh's zone.

export const TZ = 'America/New_York';

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
const F = {
  day: fmt({ weekday: 'short', month: 'short', day: 'numeric' }),
  dayLong: fmt({ weekday: 'long', month: 'long', day: 'numeric' }),
  time: fmt({ hour: 'numeric', minute: '2-digit' }),
  clock: fmt({ weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }),
  md: fmt({ month: 'short', day: 'numeric' }),
  mdy: fmt({ month: 'short', day: 'numeric', year: 'numeric' }),
  month: fmt({ month: 'short' }),
  parts: fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }),
};

export const fmtDay = (iso) => F.day.format(new Date(iso));
export const fmtDayLong = (iso) => F.dayLong.format(new Date(iso));
export const fmtTime = (iso) => F.time.format(new Date(iso));
export const fmtClock = (ms) => F.clock.format(new Date(ms));
export const fmtMD = (iso) => F.md.format(new Date(iso));
export const fmtMDY = (iso) => F.mdy.format(new Date(iso));
export const fmtMonth = (iso) => F.month.format(new Date(iso));

// Clock time in another zone (the venue's), or null if the zone is unknown.
export function fmtTimeIn(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return null;
  }
}

// Calendar parts of an instant as seen in Pittsburgh.
export function etParts(iso) {
  const p = Object.fromEntries(F.parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, wd: p.weekday };
}

// Whole calendar days in Pittsburgh, so "rest days" don't depend on kickoff hours.
export function etDayNumber(iso) {
  const p = etParts(iso);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 864e5);
}

export function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export const pct1 = (x) => `${(x * 100).toFixed(1)}%`;

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const possessive = (s) => (/s$/.test(s) ? `${s}'` : `${s}'s`);

export function list(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// "in 2d 4h", "in 3h 12m", "in 45m", "105 days".
export function countdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 6e4);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d >= 14) return `in ${d} days`;
  if (d >= 1) return `in ${d}d ${h}h`;
  if (h >= 1) return `in ${h}h ${m % 60}m`;
  return `in ${m}m`;
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
}
