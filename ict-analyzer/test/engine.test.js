'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { ny, tradingDay, weekKey, sessionInfo } = require('../lib/time');
const { aggregate, KEY, atrSeries } = require('../lib/candles');
const { findSwings, findFVGs, analyzeTF } = require('../lib/ict');
const { INSTRUMENTS } = require('../lib/instruments');
const { loadDemo, loadCsv, parseCsv, alignBars } = require('../lib/data');
const { analyze, detectSetups, findSweeps, WEIGHTS, RR_TARGETS } = require('../lib/analyze');
const { parseRss, keywordSentiment } = require('../lib/news');

const T0 = Date.parse('2026-11-10T07:00:00Z') / 1000; // 02:00 New York

/** candles from a list of closes; every bar gets a 0.1 wick each side */
function fromPath(path, step = 300, t0 = T0) {
  const out = [];
  for (let i = 1; i < path.length; i++) {
    const o = path[i - 1];
    const c = path[i];
    out.push({ t: t0 + (i - 1) * step, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c, v: 1 });
  }
  return out;
}
const line = (from, to, n) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);

test('New York time is DST aware', () => {
  assert.equal(ny(Date.parse('2026-11-10T14:00:00Z') / 1000).h, 9); // EST
  assert.equal(ny(Date.parse('2026-07-10T13:00:00Z') / 1000).h, 9); // EDT
});

test('the trading day rolls over at 18:00 New York', () => {
  assert.equal(tradingDay(Date.parse('2026-11-10T22:59:00Z') / 1000), '2026-11-10'); // 17:59
  assert.equal(tradingDay(Date.parse('2026-11-10T23:00:00Z') / 1000), '2026-11-11'); // 18:00
  // Sunday 18:00 belongs to Monday's week
  assert.equal(weekKey(Date.parse('2026-11-08T23:30:00Z') / 1000), '2026-11-09');
});

test('killzones and silver bullet windows', () => {
  const am = sessionInfo(Date.parse('2026-11-10T15:15:00Z') / 1000); // 10:15 NY
  assert.equal(am.killzone.key, 'nyam');
  assert.match(am.silverBullet.name, /AM Silver Bullet/);
  assert.equal(sessionInfo(Date.parse('2026-11-10T17:30:00Z') / 1000).killzone.key, 'lunch');
  assert.equal(sessionInfo(Date.parse('2026-11-10T11:30:00Z') / 1000).killzone, null); // 06:30 NY
});

test('aggregation builds higher timeframes', () => {
  const m1 = fromPath(line(100, 110, 60), 60, Date.parse('2026-11-10T14:00:00Z') / 1000);
  const m5 = aggregate(m1, KEY.M5);
  assert.equal(m5.length, 12);
  assert.equal(m5[0].o, m1[0].o);
  assert.equal(m5[0].c, m1[4].c);
  assert.equal(m5[0].h, Math.max(...m1.slice(0, 5).map((c) => c.h)));
});

test('swing points', () => {
  const c = fromPath([100, 101, 102, 103, 102, 101, 100, 101, 102]);
  const sw = findSwings(c, 2);
  assert.deepEqual(sw.map((s) => s.type), ['H', 'L']);
  assert.equal(sw[0].price, 103.1);
  assert.equal(sw[1].price, 99.9);
});

test('fair value gap life cycle: created, tapped, inverted', () => {
  // bar1 high 100.6, bar3 low 102.4 -> bullish gap 100.6..102.4
  const gap = (path) => { const c = fromPath(path); return findFVGs(c, atrSeries(c)).find((x) => x.dir === 1 && x.bot === 100.6); };
  let g = gap([100, 100.5, 102.5, 103, 103.4]);
  assert.ok(g, 'gap found');
  assert.equal(g.top, 102.4);
  assert.equal(g.ce, 101.5);
  assert.equal(g.tapped, false);
  // price comes back into the gap
  g = gap([100, 100.5, 102.5, 103, 103.4, 102.2, 102.8]);
  assert.equal(g.tapped, true);
  assert.equal(g.inverted, false);
  // price closes below the gap -> it now acts as bearish resistance (IFVG)
  g = gap([100, 100.5, 102.5, 103, 103.4, 101.5, 100.2, 100.0]);
  assert.equal(g.inverted, true);
  assert.equal(g.actDir, -1);
  assert.equal(g.kind, 'IFVG');
});

test('a gap across a session halt is not a fair value gap', () => {
  const c = fromPath([100, 100.2, 100.1, 100.3, 100.2, 100.4, 100.5, 102.5, 103], 300);
  for (let i = 6; i < c.length; i++) c[i].t += 3600; // one-hour halt before the jump
  assert.equal(findFVGs(c, atrSeries(c)).length, 0);
});

test('structure: break of structure then a shift', () => {
  const up = [100, 101, 102, 101, 100.5, 101.5, 103, 104, 103, 102.5, 103.5, 105];
  const down = [104, 103, 101, 99, 97];
  const a = analyzeTF(fromPath([...up, ...down]), { k: 1 });
  assert.equal(a.events[0].dir, 1);
  assert.equal(a.events[0].type, 'BOS');
  const flip = a.events.find((e) => e.dir === -1);
  assert.ok(flip, 'a bearish break exists');
  assert.ok(['MSS', 'CHoCH'].includes(flip.type));
  assert.equal(a.trend, -1);
});

test('entry model: raid of a low, structure shift, fair value gap', () => {
  const inst = INSTRUMENTS.MGC;
  const path = [103, ...line(103, 100.1, 10), ...line(100.1, 104, 10), ...line(104, 101.5, 7), ...line(101.5, 102.5, 3),
    101.9, 101.3, 100.7, 100.1, 99.5, 100.4, 101.6, 103.2, 103.8, 104.2, 104.0, 104.1, 104.15];
  const c = fromPath(path);
  const low = Math.min(...c.slice(0, 20).map((b) => b.l));
  const pools = [{ side: 'SSL', price: low, label: 'PDL', strength: 3, t: c[20].t, takenT: null }];
  const a = analyzeTF(c, { k: 2 });
  const sweeps = findSweeps(c, pools);
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].reclaimed, true);

  const setups = detectSetups(1, 'M5', a, sweeps, 72, inst);
  assert.equal(setups.length, 1);
  const s = setups[0];
  assert.equal(s.mss, true);
  assert.equal(s.mssDisp, true);
  assert.equal(s.swept, 'PDL');
  assert.equal(s.state, 'pending');
  assert.ok(s.extreme < low, 'the raid traded below the pool');
  assert.ok(s.stop < s.entry, 'stop is below a long entry');
  assert.ok(s.stop <= s.extreme || s.stopKind === 'local');
  assert.ok(s.entry < c[c.length - 1].c, 'a pending long entry sits below price');
  assert.ok(['FVG', 'Order block', 'Breaker', 'IFVG'].includes(s.entryType));
  // no short setup from the same data
  assert.equal(detectSetups(-1, 'M5', a, sweeps, 72, inst).length, 0);
});

test('full analysis on simulated data is consistent', () => {
  const now = Date.parse('2026-11-10T14:40:00Z') / 1000;
  for (const key of ['MNQ', 'MGC']) {
    const inst = INSTRUMENTS[key];
    for (let k = 0; k < 12; k++) {
      const d = loadDemo(inst, now - k * 5400);
      const r = analyze({ inst, tf: d.tf, smt: d.smt, news: null, source: 'demo' });
      const p = r.plan;
      assert.ok(['LONG', 'SHORT', 'WAIT'].includes(p.action));
      assert.equal(r.narrative.length, 10);
      const max = p.checklist.reduce((x, y) => x + y.max, 0);
      assert.equal(max, 100);
      const news = p.checklist.filter((c) => c.key.startsWith('news')).reduce((x, y) => x + y.max, 0);
      assert.equal(news, 12.5);
      assert.ok(p.score >= 0 && p.score <= 100);
      for (const c of p.checklist) assert.ok(c.pts >= 0 && c.pts <= c.max, `${c.key} within its weight`);
      if (p.entry !== undefined) {
        assert.ok(p.dir * (p.entry - p.stop) > 0, 'stop is on the losing side');
        assert.deepEqual(p.targets.map((t) => t.rr), RR_TARGETS);
        for (const t of p.targets) {
          const rr = (p.dir * (t.price - p.entry)) / Math.abs(p.entry - p.stop);
          assert.ok(Math.abs(rr - t.rr) < 0.06, `target ${t.rr}R is ${rr.toFixed(2)}R away`);
        }
        assert.ok(RR_TARGETS.includes(p.preferred));
      }
      if (p.action !== 'WAIT') {
        assert.ok(p.score >= r.meta.minScore);
        assert.ok(p.dir * r.bias.sum > -4, 'never trades against a clear higher-timeframe bias');
        assert.equal(p.action, p.dir === 1 ? 'LONG' : 'SHORT');
      } else assert.ok(p.reason);
    }
  }
});

test('ICT carries 87.5% of the score and news 12.5%', () => {
  const { newsSentiment, newsCalendar, ...ict } = WEIGHTS;
  assert.equal(Object.values(ict).reduce((a, b) => a + b, 0), 87.5);
  assert.equal(newsSentiment + newsCalendar, 12.5);
});

test('high-impact news inside 30 minutes blocks a trade and costs points', () => {
  const inst = INSTRUMENTS.MNQ;
  const now = Date.parse('2026-11-10T14:40:00Z') / 1000;
  const mk = (minutes) => ({ calendarOk: true, headlinesOk: true, events: [], headlines: [], sentiment: { score: 0, label: 'Neutral / mixed', method: 'test' }, nextEvent: minutes === null ? null : { title: 'CPI m/m', impact: 'High', minutes, when: 'x' } });
  const d = loadDemo(inst, now);
  const calm = analyze({ inst, tf: d.tf, smt: d.smt, news: mk(null), source: 'demo' });
  const hot = analyze({ inst, tf: d.tf, smt: d.smt, news: mk(10), source: 'demo' });
  const pts = (r) => r.plan.checklist.find((c) => c.key === 'newsCalendar').pts;
  assert.equal(pts(calm), 5);
  assert.equal(pts(hot), 0);
  assert.equal(hot.plan.action, 'WAIT');
});

test('CSV import: unix and ISO timestamps, any column order', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`${T0 + i * 300},${100 + i},${101 + i},${99 + i},${100.5 + i},10`);
  const a = parseCsv(`time,open,high,low,close,Volume\n${rows.join('\n')}`);
  assert.equal(a.length, 40);
  assert.equal(a[0].t, T0);
  const iso = [];
  for (let i = 0; i < 40; i++) iso.push(`${100.5 + i},${new Date((T0 + i * 300) * 1000).toISOString()},${101 + i},${99 + i},${100 + i}`);
  const b = parseCsv(`Close,Time,High,Low,Open\n${iso.join('\n')}`);
  assert.equal(b[5].t, T0 + 1500);
  assert.equal(b[5].o, 105);
  assert.throws(() => parseCsv('a,b\n1,2'), /at least 30/);
  assert.throws(() => loadCsv(`time,open,high,low,close\n${rows.map((r) => r.replace(/^\d+/, (t) => String(Number(t) * 7))).join('\n')}`), /timeframe/);
});

test('the live feed snapshot row is folded into its candle', () => {
  const bars = [{ t: 3600, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 }, { t: 7200, o: 1.5, h: 1.8, l: 1.4, c: 1.6, v: 3 }, { t: 7200 + 1559, o: 1.9, h: 1.9, l: 1.9, c: 1.9, v: 0 }];
  const out = alignBars(bars, 3600);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { t: 7200, o: 1.5, h: 1.9, l: 1.4, c: 1.9, v: 3 });
});

test('headline parsing and tone', () => {
  const xml = `<rss><channel>
    <item><title>Gold surges to record high as dollar weakens - Reuters</title><link>https://example.com/a</link><pubDate>Tue, 10 Nov 2026 12:00:00 GMT</pubDate><source url="x">Reuters</source></item>
    <item><title>Gold prices jump on safe-haven demand &amp; rate cut bets - AP</title><link>https://example.com/b</link><pubDate>Tue, 10 Nov 2026 11:00:00 GMT</pubDate><source url="x">AP</source></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Gold surges to record high as dollar weakens');
  assert.equal(items[1].title, 'Gold prices jump on safe-haven demand & rate cut bets');
  const now = Date.parse('2026-11-10T13:00:00Z') / 1000;
  assert.ok(keywordSentiment(items, 'gold', now).score > 0);
  const bad = [{ title: 'Wall Street tumbles as tech stocks sink in broad selloff', t: now - 600 }, { title: 'Nasdaq slides on hot inflation and tariff fears', t: now - 900 }];
  assert.ok(keywordSentiment(bad, 'nasdaq', now).score < 0);
});
