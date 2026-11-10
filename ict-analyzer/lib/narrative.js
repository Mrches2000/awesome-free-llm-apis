'use strict';
// Turns the numbers into the written, section-by-section ICT breakdown.

const { fmtTime, DOW_NAME } = require('./time');

const tw = (t) => (t > 0 ? 'bullish' : t < 0 ? 'bearish' : 'undefined');
const pct = (x) => `${(x * 100).toFixed(0)}%`;

function zoneList(a, name, price, f, max = 3) {
  if (!a) return [];
  const zs = [
    ...a.fvgs.filter((g) => !g.dead && !(g.filled && !g.inverted)),
    ...a.obs.filter((b) => !b.dead),
  ].map((z) => ({ ...z, dist: price > z.top ? price - z.top : price < z.bot ? z.bot - price : 0 }));
  const fmt = (z) => `${name} ${z.actDir === 1 ? 'bullish' : 'bearish'} ${z.kind} ${f(z.bot)}–${f(z.top)}${z.kind.includes('FVG') ? ` (CE ${f((z.top + z.bot) / 2)})` : ''}${z.dist === 0 ? ' ← price is inside' : ''}`;
  const sup = zs.filter((z) => z.actDir === 1 && z.top <= price + 1e-9 || (z.actDir === 1 && z.dist === 0)).sort((x, y) => x.dist - y.dist).slice(0, max);
  const res = zs.filter((z) => z.actDir === -1 && (z.bot >= price - 1e-9 || z.dist === 0)).sort((x, y) => x.dist - y.dist).slice(0, max);
  return { support: sup.map(fmt), resistance: res.map(fmt) };
}

function buildNarrative(r, { A, KL, f, inst }) {
  const { plan, bias, session, range, levels, liquidity, smt, news, meta } = r;
  const price = meta.price;
  const sec = [];
  const add = (title, lines) => sec.push({ title, lines: lines.filter(Boolean) });

  /* 1 — verdict */
  const v = [];
  if (plan.action === 'WAIT') {
    v.push(`No trade right now. ${plan.reason || ''}`.trim());
    if (plan.state === 'await_mss' && plan.setup) {
      const s = plan.setup;
      v.push(`A ${s.dir === 1 ? 'long' : 'short'} is building on ${s.tf}: ${s.swept} was raided at ${fmtTime(s.sweepT)}. It only becomes a trade after a ${s.tf} close ${s.dir === 1 ? 'above' : 'below'} ${f(s.mssLevel)}; the invalidation is ${f(s.extreme)}.`);
    }
    if (plan.entry !== undefined) v.push(`The closest candidate is a ${plan.dir === 1 ? 'long' : 'short'} from ${f(plan.entry)} (stop ${f(plan.stop)}), shown below for reference only.`);
    for (const w of plan.wait) v.push(w.text);
  } else {
    const s = plan.setup;
    v.push(`${plan.action} ${meta.symbol} — grade ${plan.grade}, confluence ${plan.score}/100 (ICT ${plan.ictPts}/87.5, news ${plan.newsPts}/12.5).`);
    v.push(`${plan.orderType} at ${f(plan.entry)} (${plan.entryType} ${f(plan.zone[0])}–${f(plan.zone[1])} on ${plan.tf}). Stop ${f(plan.stop)} — ${f(plan.risk)} ${inst.unit === '$' ? 'dollars' : 'points'} of risk = $${plan.riskUsd.toFixed(2)} per ${meta.symbol} contract.`);
    v.push(`Targets: ${plan.targets.map((t) => `${t.rr}R ${f(t.price)}`).join(' · ')}. Preferred exit: ${plan.preferred}R — the furthest target that still has liquidity behind it.`);
    v.push(s.state === 'pending' ? 'Price has not come back to the entry yet: rest a limit order and let it come to you. If price runs to the first target without filling, cancel the order.'
      : 'Price is trading in the entry zone now.');
  }
  add('1. Verdict', v);

  /* 2 — HTF narrative */
  const h = [];
  h.push(`Overall bias: ${bias.label} (score ${bias.sum > 0 ? '+' : ''}${bias.sum} on a ±${bias.max} scale).`);
  for (const b of bias.votes) h.push(`${b.label}: ${b.detail} (${b.v > 0 ? '+' : ''}${b.v}).`);
  for (const name of ['D', 'H4', 'H1']) {
    const a = A[name];
    if (!a || !a.events.length) continue;
    const e = a.events[a.events.length - 1];
    h.push(`Last ${name} structure event: ${e.dir === 1 ? 'bullish' : 'bearish'} ${e.type} through ${f(e.level)} on ${fmtTime(e.t)}.`);
  }
  for (const i of levels.ipda) {
    const p = (price - i.lo) / (i.hi - i.lo || 1);
    h.push(`IPDA ${i.n}-day range: ${f(i.lo)} – ${f(i.hi)}; price sits at ${pct(Math.max(0, Math.min(1, p)))} of it (${p > 0.5 ? 'premium' : 'discount'}).`);
  }
  add('2. Higher-timeframe narrative and daily bias', h);

  /* 3 — liquidity */
  const l = [];
  const lst = (arr) => arr.map((p) => `${p.label} ${f(p.price)}${p.strength >= 3 ? ' ★' : ''}`).join(' · ');
  l.push(liquidity.above.length ? `Buy-side liquidity resting above price (stops above highs): ${lst(liquidity.above)}.` : 'No untouched buy-side liquidity mapped above — price is at the top of the mapped range.');
  l.push(liquidity.below.length ? `Sell-side liquidity resting below price (stops below lows): ${lst(liquidity.below)}.` : 'No untouched sell-side liquidity mapped below — price is at the bottom of the mapped range.');
  const taken = r.pools.filter((p) => p.takenT !== null).sort((x, y) => y.takenT - x.takenT).slice(0, 5);
  if (taken.length) l.push(`Recently taken: ${taken.map((p) => `${p.label} ${f(p.price)} (${fmtTime(p.takenT)})`).join(' · ')}.`);
  if (levels.pdh !== null) l.push(`Previous day: high ${f(levels.pdh)}, low ${f(levels.pdl)}. Today so far: high ${f(levels.dayHigh)}, low ${f(levels.dayLow)}.`);
  if (levels.pwh !== null) l.push(`Previous week: high ${f(levels.pwh)}, low ${f(levels.pwl)}.`);
  if (liquidity.above[0] && liquidity.below[0]) {
    const up = liquidity.above[0].price - price;
    const dn = price - liquidity.below[0].price;
    l.push(`Nearest pools: ${f(up)} above vs ${f(dn)} below. ${bias.dir === 1 ? 'With a bullish bias the buy-side is the draw; the sell-side below is where a manipulation raid would set up the long.' : bias.dir === -1 ? 'With a bearish bias the sell-side is the draw; the buy-side above is where a manipulation raid would set up the short.' : 'Bias is mixed, so wait for one side to be raided and rejected before picking a direction.'}`);
  }
  l.push('★ marks the heaviest pools (previous day/week extremes, equal highs/lows, 20-day extremes).');
  add('3. Liquidity map and draw on liquidity', l);

  /* 4 — premium / discount */
  const d = [];
  if (range) {
    d.push(`H1 dealing range: ${f(range.lo)} (low, ${fmtTime(range.loT)}) to ${f(range.hi)} (high, ${fmtTime(range.hiT)}). Equilibrium ${f(range.eq)}.`);
    d.push(`Price ${f(price)} is at ${pct(range.pos)} of the range — ${range.pos > 0.5 ? 'PREMIUM: favourable for selling, expensive for buying' : 'DISCOUNT: favourable for buying, cheap for selling'}.`);
    const span = range.hi - range.lo;
    d.push(`OTE for longs (62–79% retracement down from the high): ${f(range.hi - 0.62 * span)} – ${f(range.hi - 0.79 * span)}. OTE for shorts: ${f(range.lo + 0.62 * span)} – ${f(range.lo + 0.79 * span)}.`);
  }
  add('4. Premium, discount and OTE', d);

  /* 5 — PD arrays */
  const a5 = [];
  for (const name of ['D', 'H4', 'H1', 'M15', 'M5']) {
    const z = zoneList(A[name], name, price, f, name === 'M5' || name === 'M15' ? 2 : 3);
    if (!z.support) continue;
    if (z.support.length) a5.push(`Support below / at price — ${z.support.join('; ')}.`);
    if (z.resistance.length) a5.push(`Resistance above / at price — ${z.resistance.join('; ')}.`);
  }
  for (const g of levels.gaps) a5.push(`${g.name === 'NDOG' ? 'New day opening gap' : 'New week opening gap'} (${g.name}): ${f(g.bot)} – ${f(g.top)}${price >= g.bot && price <= g.top ? ' ← price is inside' : price > g.top ? ' (below price, acts as support / magnet)' : ' (above price, acts as resistance / magnet)'}.`);
  for (const name of ['H1', 'M15', 'M5']) {
    const a = A[name];
    if (!a || !a.bprs.length) continue;
    const b = a.bprs[a.bprs.length - 1];
    a5.push(`${name} balanced price range (overlapping bullish + bearish FVG): ${f(b.bot)} – ${f(b.top)}.`);
  }
  if (!a5.length) a5.push('No open PD arrays near price on the analysed timeframes.');
  add('5. PD arrays: fair value gaps, order blocks, breakers, gaps', a5);

  /* 6 — time */
  const t = [];
  t.push(`New York time: ${session.nyTime}. ${session.killzone ? `Inside the ${session.killzone.name}.` : 'Outside the killzones.'}${session.silverBullet ? ` ${session.silverBullet.name} is open.` : ''}${session.macro ? ` Algorithmic macro window ${session.macro}.` : ''}`);
  if (session.next) t.push(`Next window: ${session.next.name} at ${session.next.at} NY (in ${Math.floor(session.next.inMinutes / 60)}h ${session.next.inMinutes % 60}m).`);
  const o = levels.opens;
  const ol = [];
  if (o.midnight) ol.push(`midnight ${f(o.midnight.price)}`);
  if (o.o830) ol.push(`08:30 ${f(o.o830.price)}`);
  if (o.o930) ol.push(`09:30 ${f(o.o930.price)}`);
  if (o.daily) ol.push(`18:00 daily ${f(o.daily.price)}`);
  if (o.weekly) ol.push(`weekly ${f(o.weekly.price)}`);
  if (ol.length) t.push(`Opening prices — ${ol.join(' · ')}. Price is ${o.midnight ? (price > o.midnight.price ? 'above' : 'below') + ' the midnight open' : (o.daily && price > o.daily.price ? 'above' : 'below') + ' the daily open'}.`);
  const today = levels.sessions.filter((s) => s.day === KL.today);
  const asia = today.find((s) => s.key === 'asia');
  if (asia) {
    const hiTaken = levels.dayHigh > asia.hi;
    const loTaken = levels.dayLow < asia.lo;
    let amd = `Power of 3 (AMD): Asia built the accumulation range ${f(asia.lo)} – ${f(asia.hi)}${asia.done ? '' : ' (still forming)'}. `;
    if (asia.done) {
      if (hiTaken && loTaken) amd += 'Both sides of the Asian range have been taken — the manipulation is done on both sides; trade the side that displaced away.';
      else if (loTaken) amd += `The Asian low was raided${price > asia.lo ? ' and price is back above it — classic bullish manipulation (Judas swing down), distribution should be higher' : ' and price is still below it — sell-side delivery in progress'}.`;
      else if (hiTaken) amd += `The Asian high was raided${price < asia.hi ? ' and price is back below it — classic bearish manipulation (Judas swing up), distribution should be lower' : ' and price is still above it — buy-side delivery in progress'}.`;
      else amd += 'Neither side has been raided yet — the manipulation leg is still to come. Expect a false move through one side first.';
    }
    t.push(amd);
  }
  for (const s of today.filter((x) => x.key !== 'asia' && x.done)) t.push(`${s.name} session range: ${f(s.lo)} – ${f(s.hi)}.`);
  t.push(`Day of week: ${DOW_NAME[session.dow]}. ${[0, 1].includes(session.dow) ? 'Early in the week the weekly high or low is often still being formed — be patient.' : session.dow === 5 ? 'Friday: expect profit-taking back into the weekly range (TGIF); avoid holding into the close.' : 'Mid-week days usually deliver the cleanest expansion.'}`);
  add('6. Time: killzones, opening prices, Power of 3', t);

  /* 7 — SMT */
  const s7 = [];
  if (smt === null) s7.push(`Data for ${meta.smtName} was not available, so SMT divergence could not be checked.`);
  else if (!smt.length) s7.push(`No SMT divergence against ${meta.smtName} at the most recent swing highs or lows — both markets confirm each other.`);
  else for (const x of smt) s7.push(`${x.text} (${x.age} bars ago).`);
  add('7. SMT divergence', s7);

  /* 8 — entry model */
  const e = [];
  const s = plan.setup;
  if (s) {
    const D = s.dir === 1;
    e.push(`Step 1 — Liquidity raid: ${D ? 'sell-side' : 'buy-side'} liquidity (${s.swept}) was taken on ${s.tf} at ${fmtTime(s.sweepT)}; the ${D ? 'low' : 'high'} of the raid is ${f(s.extreme)}.`);
    e.push(s.cisd ? `Step 2 — Change in state of delivery: price closed back ${D ? 'above' : 'below'} ${f(s.cisdLevel)} at ${fmtTime(s.cisdT)}.` : `Step 2 — Change in state of delivery: not yet (needs a close ${D ? 'above' : 'below'} ${f(s.cisdLevel)}).`);
    e.push(s.mss ? `Step 3 — Market structure shift: ${s.tf} closed ${D ? 'above' : 'below'} the swing at ${f(s.mssLevel)} at ${fmtTime(s.mssT)}${s.mssDisp ? ' with displacement' : ' (weak displacement — lower quality)'}.` : `Step 3 — Market structure shift: pending. Needs a ${s.tf} close ${D ? 'above' : 'below'} ${f(s.mssLevel)}.`);
    if (s.entry !== undefined) {
      e.push(`Step 4 — Entry array: ${s.entryType} ${f(s.zoneBot)} – ${f(s.zoneTop)} (consequent encroachment ${f(s.ce)}). That is a ${pct(s.retr)} retracement of the leg ${f(s.extreme)} → ${f(s.legHigh)}${s.ote ? ', inside the optimal trade entry zone' : ''}${s.unicorn ? '; it overlaps a breaker block (Unicorn)' : ''}.`);
      e.push(s.stopKind === 'raid' ? `Step 5 — Risk: stop ${f(s.stop)}, just beyond the raid ${D ? 'low' : 'high'}. If that level trades, the idea is wrong.` : `Step 5 — Risk: stop ${f(s.stop)}, just beyond the swing that protects the entry array (tighter continuation stop; the raid ${D ? 'low' : 'high'} at ${f(s.extreme)} is the wider, safer alternative).`);
      for (const tp of plan.targets) e.push(`Target ${tp.rr}R = ${f(tp.price)} — ${tp.note}${tp.backed ? '' : ' (beyond the mapped draw: lower probability)'}.`);
      if (s.state === 'triggered') e.push(`Status: the entry filled at ${fmtTime(s.fillT)} and price is now ${s.curR.toFixed(1)}R from entry. Do not chase; wait for a new setup.`);
      if (s.silverBullet) e.push(`The shift happened inside the ${s.silverBullet}.`);
    }
  } else {
    e.push('No raid → shift → fair-value-gap sequence is present on M15, M5 or M1 right now.');
    for (const w of plan.wait) e.push(w.text);
  }
  if (r.alternatives.length) e.push(`Other setups on the board: ${r.alternatives.map((x) => `${x.dir === 1 ? 'long' : 'short'} ${x.tf} (${x.state.replace('_', ' ')}, ${x.score}/100)`).join('; ')}.`);
  add('8. Entry model step by step', e);

  /* 9 — news */
  const n9 = [];
  if (!news) n9.push('News feed not loaded. The score treats news as neutral.');
  else {
    if (news.sentiment) n9.push(`Headline tone: ${news.sentiment.label} (${news.sentiment.score > 0 ? '+' : ''}${news.sentiment.score.toFixed(2)} on a −1…+1 scale, ${news.sentiment.method}). ${news.sentiment.summary || ''}`.trim());
    if (news.nextEvent) n9.push(`Next high-impact USD release: ${news.nextEvent.title} ${news.nextEvent.minutes >= 0 ? `in ${Math.floor(news.nextEvent.minutes / 60)}h ${news.nextEvent.minutes % 60}m` : 'just out'} (${news.nextEvent.when} NY).`);
    else if (news.calendarOk) n9.push('No high-impact USD release left on the calendar window.');
    else n9.push('Economic calendar could not be loaded — check it by hand before trading.');
    n9.push('News carries 12.5% of the score. In ICT terms a release is not a reason to trade; it is the volatility that runs price into liquidity. Trade the raid after the number, not the number.');
  }
  add('9. News and world events (12.5% weight)', n9);

  /* 10 — risk */
  const k = [];
  if (plan.entry !== undefined) {
    k.push(`Risk per contract: ${f(plan.risk)} × $${inst.pointValue} = $${plan.riskUsd.toFixed(2)}. Size = (account risk in $) ÷ ${plan.riskUsd.toFixed(2)}, rounded down.`);
    k.push(`Invalidation: any trade through ${f(plan.stop)}. Also stand down if ${plan.tf} closes ${plan.dir === 1 ? 'below' : 'above'} the entry array without reacting.`);
    k.push('Management: take partials at 1.5R and move the stop to break-even; let the remainder run to the preferred target.');
  }
  k.push('One setup per session. Do not trade during NY lunch (12:00–13:00) or within 30 minutes before a high-impact release.');
  add('10. Risk plan', k);

  return sec;
}

module.exports = { buildNarrative };
