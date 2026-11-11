/*
 * A small made-up gold chart for the first screen, so the page shows how an analysis
 * looks before the trader adds anything. Deterministic. Not real prices.
 * Pattern: downtrend, the old low is raided, a strong move up leaves a gap, price pulls back to it.
 */
(function (root) {
  'use strict';

  function makeExample() {
    let seed = 11;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const c = []; let p = 4138;
    const push = (o, h, l, cl) => c.push({ o, h, l, c: cl });
    for (let i = 0; i < 26; i++) { const o = p; p = o - 1.15 + (rnd() - 0.5) * 3.2; push(o, Math.max(o, p) + rnd() * 1.5, Math.min(o, p) - rnd() * 1.5, p); }
    const highBefore = Math.max(...c.map((x) => x.h));
    const lowBefore = Math.min(...c.map((x) => x.l));
    const raid = c.length;
    { const o = p; const l = lowBefore - 3.4; p = o + 1.1; push(o, o + 1, l, p); }          // wick through the old low, closes back up
    { const o = p; p = o + 0.7; push(o, p + 0.6, o - 0.4, p); }
    const A = c.length;
    { const o = p; p = o + 4.8; push(o, p + 0.3, o - 0.2, p); }                           // displacement
    { const o = p; p = o + 5.6; push(o, p + 0.3, o - 0.2, p); }
    { const o = p; p = o + 3.4; push(o, p + 0.4, o + 0.9, p); }                           // low above candle A's high: a gap
    const gapBottom = c[A].h; const gapTop = c[A + 2].l;
    for (let i = 0; i < 3; i++) { const o = p; p = o + 0.5 + (rnd() - 0.5) * 1.6; push(o, Math.max(o, p) + 0.8, Math.min(o, p) - 0.7, p); }
    const peak = Math.max(...c.slice(A).map((x) => x.h));
    // pull back toward the gap
    const steps = 14; const target = gapTop + 1.4;
    for (let i = 1; i <= steps; i++) { const o = p; const goal = peak + (target - peak) * (i / steps); p = goal + (rnd() - 0.5) * 1.4; push(o, Math.max(o, p) + rnd() * 1.0, Math.min(o, p) - rnd() * 1.0, p); }
    const last = c[c.length - 1].c;
    const lastLow = Math.min(...c.slice(-3).map((x) => x.l));
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      candles: c.map((x) => ({ o: r1(x.o), h: r1(x.h), l: r1(x.l), c: r1(x.c) })),
      last: r1(last), raidIndex: raid, gapIndex: A, gapTop: r1(gapTop), gapBottom: r1(gapBottom), raidLow: r1(c[raid].l), highBefore: r1(highBefore), peak: r1(peak), lastLow: r1(lastLow),
    };
  }

  /** The reading a good analyst would write for this chart, in the shape the checker expects. */
  function exampleRaw(ex) {
    const entry = ex.gapTop; const stop = Math.round((ex.raidLow - 1.2) * 10) / 10;
    return {
      readable: true, problems: '',
      chart: { instrument: 'Gold futures (example)', timeframes: ['5m'], last_price: ex.last, visible_high: ex.highBefore + 4, visible_low: ex.raidLow - 6, period: '' },
      axis: { labels: [], tags: [ex.last], plot_right: 0.93 },
      marks: [
        { kind: 'liquidity', dir: -1, label: 'Old high', price: ex.highBefore, x: 0.05 },
        { kind: 'sweep', dir: 1, price: ex.raidLow, x: 0.5 },
        { kind: 'fvg', dir: 1, label: 'FVG', top: ex.gapTop, bottom: ex.gapBottom, x: 0.56 },
        { kind: 'shift', dir: 1, label: 'MSS', price: ex.gapBottom, x: 0.55 },
      ],
      swings: [{ type: 'high', price: ex.highBefore }, { type: 'low', price: ex.raidLow }, { type: 'high', price: ex.peak }],
      indicators: [], candles: 'Raid of the low, then a strong move up that left a gap.',
      structure: { trend: 'bullish', events: [{ type: 'MSS', direction: 'bullish', level: ex.gapBottom, when: '' }] },
      liquidity: { above: [{ label: 'Old high', price: ex.highBefore }], below: [{ label: 'Raid low', price: ex.raidLow }], swept: [{ label: 'Old low', price: ex.raidLow, when: '' }] },
      pd_arrays: [{ type: 'FVG', direction: 'bullish', low: ex.gapBottom, high: ex.gapTop, note: '' }],
      dealing_range: { low: ex.raidLow, high: ex.highBefore },
      bias: { direction: 'bullish', draw: 'old high', why: 'Low raided, then price moved up with force.' },
      setup: { direction: 'long', state: 'pending', model: 'Raid, shift, gap', timeframe: '5m', raid: { label: 'Old low', price: ex.raidLow }, shift_level: ex.gapBottom, leg: { from: ex.raidLow, to: ex.peak }, entry, entry_array: 'FVG', stop, stop_reason: 'below the raid low', target_liquidity: { label: 'Old high', price: ex.highBefore }, wait_for: '' },
      scores: { htf: { pts: 12, why: 'Higher lows after the raid.' }, sweep: { pts: 12, why: 'Old low taken, closed back up.' }, mss: { pts: 12, why: 'Strong move up left a gap.' }, array: { pts: 8, why: 'Clean, untouched gap.' }, open: { pts: 3.5, why: 'Entry is below the open.' }, h1: { pts: 3, why: 'One timeframe up agrees.' } },
      summary: 'Raid, shift, gap. Wait for the pullback into the gap.', confidence: 'high',
    };
  }

  const api = { makeExample, exampleRaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.IctExample = api;
}(typeof window !== 'undefined' ? window : globalThis));
