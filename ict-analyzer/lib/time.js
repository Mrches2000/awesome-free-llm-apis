'use strict';
// All ICT time concepts are defined in New York local time (DST aware).

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
});
const cache = new Map();

/** New York wall-clock parts for a unix timestamp in seconds. */
function ny(t) {
  let v = cache.get(t);
  if (v) return v;
  const p = {};
  for (const x of fmt.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  const h = Number(p.hour) % 24;
  const mi = Number(p.minute);
  v = {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day), h, mi,
    mins: h * 60 + mi, dow: DOW[p.weekday], date: `${p.year}-${p.month}-${p.day}`,
  };
  if (cache.size > 500000) cache.clear();
  cache.set(t, v);
  return v;
}

/** Futures trading day: opens 18:00 NY the evening before. Returns YYYY-MM-DD. */
function tradingDay(t) { return ny(t + 6 * 3600).date; }

/** Monday (YYYY-MM-DD) of the trading week the bar belongs to. */
function weekKey(t) {
  const n = ny(t + 6 * 3600);
  const dt = new Date(Date.UTC(n.y, n.mo - 1, n.d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** Minutes since the 18:00 NY open of the trading day (0..1439). */
function minsSinceOpen(t) { return (ny(t).mins + 360) % 1440; }

const hm = (h, m = 0) => h * 60 + m;

// Sessions used for session highs/lows (liquidity) – [start, end) in NY minutes.
const SESSIONS = [
  { key: 'asia', name: 'Asia', start: hm(18), end: hm(24) },
  { key: 'london', name: 'London', start: hm(2), end: hm(5) },
  { key: 'nyam', name: 'NY AM', start: hm(8, 30), end: hm(11) },
  { key: 'nypm', name: 'NY PM', start: hm(13, 30), end: hm(16) },
];

// Killzones: the windows where ICT setups are expected to form.
const KILLZONES = [
  { key: 'asia', name: 'Asian killzone', start: hm(20), end: hm(24), quality: 0.4 },
  { key: 'london', name: 'London killzone', start: hm(2), end: hm(5), quality: 0.8 },
  { key: 'nypre', name: 'NY pre-market (07:00–08:30)', start: hm(7), end: hm(8, 30), quality: 0.5 },
  { key: 'nyam', name: 'New York AM killzone', start: hm(8, 30), end: hm(11), quality: 0.85 },
  { key: 'lunch', name: 'NY lunch (no-trade zone)', start: hm(12), end: hm(13), quality: 0 },
  { key: 'nypm', name: 'New York PM killzone', start: hm(13, 30), end: hm(16), quality: 0.75 },
];

const SILVER_BULLETS = [
  { name: 'London Silver Bullet (03:00–04:00)', start: hm(3), end: hm(4) },
  { name: 'AM Silver Bullet (10:00–11:00)', start: hm(10), end: hm(11) },
  { name: 'PM Silver Bullet (14:00–15:00)', start: hm(14), end: hm(15) },
];

const MACROS = [
  [hm(2, 33), hm(3)], [hm(4, 3), hm(4, 30)], [hm(8, 50), hm(9, 10)], [hm(9, 50), hm(10, 10)],
  [hm(10, 50), hm(11, 10)], [hm(11, 50), hm(12, 10)], [hm(13, 10), hm(13, 40)], [hm(15, 15), hm(15, 45)],
].map(([start, end]) => ({ start, end }));

const inWin = (mins, w) => mins >= w.start && mins < w.end;
const p2 = (n) => String(n).padStart(2, '0');
const fmtMins = (m) => `${p2(Math.floor(m / 60) % 24)}:${p2(m % 60)}`;

function fmtTime(t) {
  const n = ny(t);
  return `${DOW_NAME[n.dow]} ${p2(n.mo)}/${p2(n.d)} ${p2(n.h)}:${p2(n.mi)}`;
}

/** Describes where "now" sits in the ICT trading day. */
function sessionInfo(t) {
  const n = ny(t);
  const kz = KILLZONES.find((k) => inWin(n.mins, k)) || null;
  const sb = SILVER_BULLETS.find((k) => inWin(n.mins, k)) || null;
  const macro = MACROS.find((k) => inWin(n.mins, k)) || null;
  // next tradable killzone
  let next = null;
  for (let add = 1; add <= 1440; add++) {
    const m = (n.mins + add) % 1440;
    const k = KILLZONES.find((z) => z.quality > 0.45 && z.start === m);
    if (k) { next = { name: k.name, inMinutes: add, at: fmtMins(k.start) }; break; }
  }
  return {
    nyTime: `${DOW_NAME[n.dow]} ${p2(n.h)}:${p2(n.mi)}`, mins: n.mins, dow: n.dow, dowName: DOW_NAME[n.dow],
    killzone: kz, silverBullet: sb,
    macro: macro ? `${fmtMins(macro.start)}–${fmtMins(macro.end)}` : null, next,
  };
}

module.exports = {
  ny, tradingDay, weekKey, minsSinceOpen, SESSIONS, KILLZONES, SILVER_BULLETS, MACROS,
  inWin, fmtTime, fmtMins, sessionInfo, DOW_NAME, hm,
};
