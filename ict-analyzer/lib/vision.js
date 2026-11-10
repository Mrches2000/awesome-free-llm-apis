'use strict';
// Screenshot mode: an AI vision model looks at the trader's own chart picture
// (candles, price axis, indicators, drawings) and fills in the ICT analysis.
// The model reads and reasons; this code checks its numbers, computes the
// targets, applies the same score weights and trade rules as the data engine.

const { sessionInfo, fmtTime } = require('./time');
const { WEIGHTS, RR_TARGETS, MIN_SCORE, timeScore, newsScores, deadHours, grade } = require('./analyze');

// Vision-capable models with a free tier, from this repository's list.
const PROVIDERS = [
  {
    id: 'ovh', name: 'OVHcloud — free, no key needed', needsKey: false, keyUrl: null,
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    models: ['Qwen2.5-VL-72B-Instruct', 'Mistral-Small-3.2-24B-Instruct-2506'],
    hint: 'Works straight away. Limit: 2 analyses per minute.',
  },
  {
    id: 'gemini', name: 'Google Gemini — free key', needsKey: true, keyUrl: 'https://aistudio.google.com/app/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-3.6-flash', 'gemini-2.5-flash'],
    hint: 'Usually the sharpest free reader of charts. Needs a free key from Google AI Studio.',
  },
  {
    id: 'groq', name: 'Groq — free key', needsKey: true, keyUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1', models: ['qwen/qwen3.8-27b'], hint: 'Very fast.',
  },
  {
    id: 'openrouter', name: 'OpenRouter — free key', needsKey: true, keyUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['qwen/qwen3.8-27b:free', 'nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-31b-it:free'],
    hint: 'Free models are limited to 50 requests a day.',
  },
  {
    id: 'mistral', name: 'Mistral — free key', needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys',
    baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-medium-3-5', 'mistral-small-2603'], hint: '',
  },
  { id: 'custom', name: 'Other (any OpenAI-compatible vision model)', needsKey: false, keyUrl: null, baseUrl: '', models: [], hint: 'Enter the base URL and model name yourself. The key is optional (local models need none).' },
];

// What the model scores (it cannot judge time of day or news — the code does those).
const MODEL_ITEMS = [
  ['htf', 'Higher-timeframe bias'],
  ['sweep', 'Liquidity sweep (stop raid)'],
  ['mss', 'Market structure shift + displacement'],
  ['array', 'Entry PD array'],
  ['room', 'Draw on liquidity / room to target'],
  ['pd', 'Premium / discount'],
  ['ote', 'Optimal trade entry (62–79%)'],
  ['smt', 'Indicators on your chart'],
  ['open', 'Opening price (Power of 3)'],
  ['h1', 'Higher-timeframe order flow'],
];

const SYSTEM = `You are a senior ICT (Inner Circle Trader) analyst reading a trader's chart screenshot.
Rules:
- Work only from what is visible: the candles, the price axis, the time axis, and any indicators or drawings on the chart.
- Read prices from the price axis as precisely as the picture allows. Never invent a level you cannot see.
- If something cannot be determined from the picture, say so and score it 0.
- Never force a trade. "No setup, wait" is a correct and common answer.
- If the chart shows a different market than the one the trader selected, analyse the chart you see anyway and mention the difference in "problems". Set "readable" to false only when the candles or the price axis cannot be made out.
- Reply with exactly one JSON object and nothing else. No markdown.`;

function buildPrompt({ inst, session, notes, count, context, news }) {
  const W = WEIGHTS;
  const L = [];
  L.push(`MARKET THE TRADER SELECTED: ${inst.name} (${inst.key}), minimum price step ${inst.tick}.`);
  L.push(`TIME NOW: ${session.nyTime} New York — ${session.killzone ? session.killzone.name : 'outside the ICT killzones'}${session.silverBullet ? `, ${session.silverBullet.name}` : ''}.`);
  L.push(`SCREENSHOTS: ${count}. ${count > 1 ? 'They are usually different timeframes of the same market: use the highest timeframe for bias and the lowest for the entry.' : ''}`);
  if (notes) L.push(`TRADER'S NOTE: ${String(notes).slice(0, 500)}`);
  if (context) {
    L.push('', 'REFERENCE DATA from a price feed that is about 10 minutes late (it may be a different contract than the chart). If its last price differs from the chart by more than 0.3%, ignore its price levels and keep only its bias:');
    L.push(...context.map((x) => `- ${x}`));
  }
  if (news) {
    L.push('', 'NEWS (already scored separately, for context only):');
    if (news.sentiment) L.push(`- Headline tone: ${news.sentiment.label}.`);
    if (news.nextEvent) L.push(`- Next high-impact USD release: ${news.nextEvent.title} in ${news.nextEvent.minutes} minutes.`);
  }
  L.push('', `METHOD — follow in order:
1. Read the chart: instrument, timeframe(s), last price, highest and lowest visible price, the time span shown.
2. Swing points: list the 6 to 10 most important swing highs and swing lows of the lowest-timeframe chart, oldest first, each with its price read from the axis and its time. Be careful: this list is the base for everything else.
3. Indicators: list EVERY indicator or drawing you can see (moving averages, VWAP, RSI, MACD, volume, bands, session boxes, trend lines, marked zones). For each, the reading must say its value AND how price relates to it (for example "price 4084 is below EMA 20 at 4086, and EMA 20 is below EMA 50 — downtrend"). Then its implication: bullish, bearish or neutral. Indicators are supporting evidence only; ICT price action decides.
4. Candles: describe the recent price action — displacement candles, long wicks and rejections, consolidation, momentum.
5. Market structure: the most recent break of structure (BOS) and any market structure shift (MSS, with displacement) or CHoCH, each with the price of the swing that was broken. A break needs a candle CLOSE beyond the swing.
6. Liquidity: buy-side pools are ABOVE current price (old highs, equal highs, session highs); sell-side pools are BELOW current price (old lows, equal lows). List only levels that sit on the chart you see. Which pools were swept recently (a wick through the level, then a close back inside)?
7. PD arrays not yet fully filled, nearest to price first, at most 6: fair value gaps (three candles where candle 3's low is above candle 1's high for a bullish gap, or candle 3's high is below candle 1's low for a bearish gap), order blocks (the last opposite-colour candle before a displacement leg that broke structure), breaker blocks, inversion FVGs. Give the low and high price of each.
8. Dealing range: the major swing low and major swing high that price is trading between.
9. Bias: bullish, bearish or neutral, and which liquidity price is being drawn to.
10. Setup. An ICT entry needs three things in this order:
   (a) a raid of liquidity AGAINST the trade: for a long, price wicks BELOW an old low and closes back above it; for a short, price wicks ABOVE an old high and closes back below it;
   (b) a market structure shift WITH the trade and with displacement: for a long a candle closes above the last lower high; for a short a candle closes below the last higher low;
   (c) a retracement entry into a fair value gap, order block or breaker left by that displacement. Longs belong in discount (lower half of the leg), shorts in premium (upper half); best is the 62–79% retracement (OTE).
   - If (a), (b) and (c) are all on the chart: give "entry" (the edge of the array nearest to price), "stop" (just beyond the raid extreme, or beyond the swing protecting the array), "leg" (from = the raid extreme, to = the furthest price reached after the shift) and "target_liquidity" (an untouched pool beyond the entry). State "ready" if price is at the entry now, "pending" if price still has to come back to it.
   - If (a) happened but (b) has not: direction is the expected side, state "await_confirmation". "shift_level" is the swing a candle must close beyond: it is ABOVE current price for a long and BELOW current price for a short. Put the raid extreme in "stop".
   - Otherwise direction "none", state "none". A market that simply trends without a raid has no setup: say so.
   - Always fill "wait_for" with the exact price action that must happen next, with prices.
   - Do NOT give take-profit prices; they are calculated from entry and stop.
11. Score each item honestly between 0 and its maximum. Give 0 when the evidence is not on the chart.`);
  L.push('', `REPLY WITH THIS JSON (numbers as numbers, prices exactly as on the axis):
{
 "readable": true,
 "problems": "anything that made the chart hard to read, or empty",
 "chart": {"instrument": "", "timeframes": [""], "last_price": 0, "visible_high": 0, "visible_low": 0, "period": ""},
 "swings": [{"type": "high|low", "price": 0, "when": ""}],
 "indicators": [{"name": "", "reading": "", "implication": "bullish|bearish|neutral"}],
 "candles": "",
 "structure": {"trend": "bullish|bearish|ranging", "events": [{"type": "BOS|MSS|CHoCH", "direction": "bullish|bearish", "level": 0, "when": ""}]},
 "liquidity": {"above": [{"label": "", "price": 0}], "below": [{"label": "", "price": 0}], "swept": [{"label": "", "price": 0, "when": ""}]},
 "pd_arrays": [{"type": "FVG|IFVG|Order block|Breaker", "direction": "bullish|bearish", "low": 0, "high": 0, "note": ""}],
 "dealing_range": {"low": 0, "high": 0},
 "bias": {"direction": "bullish|bearish|neutral", "draw": "", "why": ""},
 "setup": {"direction": "long|short|none", "state": "ready|pending|await_confirmation|none", "model": "", "timeframe": "", "raid": {"label": "", "price": 0}, "shift_level": 0, "leg": {"from": 0, "to": 0}, "entry": 0, "entry_array": "", "stop": 0, "stop_reason": "", "target_liquidity": {"label": "", "price": 0}, "wait_for": ""},
 "scores": {
  "htf": {"pts": 0, "why": "max ${W.htf}: bias of the highest timeframe visible (and the reference data) agrees with the setup direction"},
  "sweep": {"pts": 0, "why": "max ${W.sweep}: a liquidity pool was raided against the trade and price closed back"},
  "mss": {"pts": 0, "why": "max ${W.mss}: structure shifted in the setup direction with displacement (8 if without clear displacement)"},
  "array": {"pts": 0, "why": "max ${W.array}: quality of the entry FVG / order block / breaker"},
  "open": {"pts": 0, "why": "max ${W.open}: long below / short above the midnight or daily opening price, if that price is known"},
  "h1": {"pts": 0, "why": "max ${W.h1}: order flow one timeframe above the entry agrees"}
 },
 "summary": "four or five plain sentences: what the chart shows and the best move",
 "confidence": "low|medium|high"
}
Replace every "why" with your own one-sentence evidence.`);
  return L.join('\n');
}

/* ----------------------------- model call ----------------------------- */

function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The AI did not return an analysis. Try again, or pick another model in AI settings.');
  const body = s.slice(a, b + 1);
  try { return JSON.parse(body); } catch { /* try a light repair below */ }
  try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch {
    throw new Error('The AI reply was cut off or malformed. Try again, or pick another model in AI settings.');
  }
}

async function callVision({ baseUrl, apiKey, model, images, prompt, timeoutMs = 240000 }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base)) throw new Error('AI settings: the base URL must start with https:// (or http://localhost for a model on this computer).');
  if (!model) throw new Error('AI settings: choose a model.');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const content = [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
  const post = async (extra) => {
    try {
      return await fetch(`${base}/chat/completions`, {
        method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model, temperature: 0.1, max_tokens: 7000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }], ...extra }),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('The AI took too long to answer. Try again, or pick a faster model in AI settings.');
      throw new Error(`Cannot reach the AI provider (${(err.cause && err.cause.code) || err.name}).`);
    }
  };
  let res = await post({ response_format: { type: 'json_object' } });
  if (res.status === 400 || res.status === 422) res = await post({}); // some providers reject response_format
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220);
    if (res.status === 401 || res.status === 403) throw new Error('The AI provider refused the key. Check the key in AI settings.');
    if (res.status === 404) throw new Error(`The AI provider does not know the model "${model}". Pick another one in AI settings.`);
    if (res.status === 429) throw new Error('The AI provider says too many requests. Free tiers are small — wait a minute and press Analyze again.');
    if (res.status === 413) throw new Error('The screenshots are too large for this AI provider. Upload fewer or smaller pictures.');
    throw new Error(`The AI provider answered HTTP ${res.status}. ${detail}`);
  }
  const j = await res.json();
  const choice = j && j.choices && j.choices[0];
  const msg = choice && choice.message;
  let text = msg && msg.content;
  if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  if (!text) {
    if (choice && choice.finish_reason === 'length') throw new Error('This AI model spent its whole answer thinking and never wrote the analysis. Pick another model in AI settings.');
    throw new Error('The AI returned an empty answer. Try again.');
  }
  return extractJson(text);
}

/* --------------------------- normalisation ---------------------------- */

const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x !== 'string') return null;
  const n = Number(x.replace(/[,\s$]/g, ''));
  return x.trim() !== '' && Number.isFinite(n) ? n : null;
};
const str = (x, max = 600) => (x === null || x === undefined ? '' : String(x).trim().slice(0, max));
const arr = (x) => (Array.isArray(x) ? x : []);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dirOf = (s) => (/^(long|bull)/i.test(str(s)) ? 1 : /^(short|bear)/i.test(str(s)) ? -1 : 0);

/**
 * Turn the model's raw JSON into the same result shape the data engine produces.
 * The model reads the picture; every number is re-checked here and most of the
 * score is computed by this code from the levels it read, not taken on trust.
 */
function buildResult(raw, { inst, now, news, engine, modelName, count }) {
  const W = WEIGHTS;
  const session = sessionInfo(now);
  const chart = raw.chart || {};
  const last = num(chart.last_price);
  const vHigh = num(chart.visible_high);
  const vLow = num(chart.visible_low);
  if (raw.readable === false || last === null) {
    throw new Error(str(raw.problems) ? `The AI could not read this chart: ${str(raw.problems, 240)}` : 'The AI could not read this chart. Use a sharper screenshot with the candles and the price axis visible.');
  }
  const rt = (p) => Number((Math.round(p / inst.tick) * inst.tick).toFixed(inst.decimals));
  const f = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: inst.decimals, maximumFractionDigits: inst.decimals });
  const span = vHigh !== null && vLow !== null && vHigh > vLow ? vHigh - vLow : Math.abs(last) * 0.02;
  const plausible = (p) => p !== null && p > last - 3 * span && p < last + 3 * span;
  const level = (x) => ({ label: str(x && x.label, 80) || 'level', price: num(x && x.price) });

  /* ---- what the model read ---- */
  const swings = arr(raw.swings).map((x) => ({ type: /^h/i.test(str(x && x.type)) ? 'high' : 'low', price: num(x && x.price), when: str(x && x.when, 40) })).filter((x) => plausible(x.price)).slice(-12);
  const liq = raw.liquidity || {};
  const above = arr(liq.above).map(level).filter((x) => plausible(x.price) && x.price > last).sort((x, y) => x.price - y.price).slice(0, 6);
  const below = arr(liq.below).map(level).filter((x) => plausible(x.price) && x.price < last).sort((x, y) => y.price - x.price).slice(0, 6);
  const swept = arr(liq.swept).map((x) => ({ ...level(x), when: str(x && x.when, 60) })).filter((x) => plausible(x.price)).slice(0, 5);
  const arrays = arr(raw.pd_arrays).map((z) => {
    const lo = num(z && z.low); const hi = num(z && z.high);
    return { type: str(z && z.type, 30) || 'Zone', dir: dirOf(z && z.direction), low: lo !== null && hi !== null ? Math.min(lo, hi) : lo, high: lo !== null && hi !== null ? Math.max(lo, hi) : hi, note: str(z && z.note, 160) };
  }).filter((z) => plausible(z.low) && plausible(z.high)).slice(0, 6);
  const events = arr(raw.structure && raw.structure.events).map((e) => ({ type: str(e && e.type, 10) || 'BOS', dir: dirOf(e && e.direction), level: num(e && e.level), when: str(e && e.when, 60) })).filter((e) => plausible(e.level)).slice(0, 6);
  const indicators = arr(raw.indicators).map((i) => ({ name: str(i && i.name, 60), reading: str(i && i.reading, 260), dir: dirOf(i && i.implication) })).filter((i) => i.name).slice(0, 12);

  // dealing range: the model's, widened by the swing points it listed
  const dr = raw.dealing_range || {};
  let drLo = num(dr.low); let drHi = num(dr.high);
  const sp = swings.map((x) => x.price);
  if (!(plausible(drLo) && plausible(drHi) && drHi > drLo)) { drLo = sp.length >= 2 ? Math.min(...sp) : null; drHi = sp.length >= 2 ? Math.max(...sp) : null; }
  const range = drLo !== null && drHi !== null && drHi > drLo ? { lo: drLo, hi: drHi, eq: (drLo + drHi) / 2, pos: clamp((last - drLo) / (drHi - drLo), 0, 1) } : null;

  // trend recomputed from the swing points (not taken from the model's word)
  const hs = swings.filter((x) => x.type === 'high').slice(-2);
  const ls = swings.filter((x) => x.type === 'low').slice(-2);
  let swingTrend = null;
  if (hs.length === 2 && ls.length === 2) {
    const hh = hs[1].price > hs[0].price; const hl = ls[1].price > ls[0].price;
    swingTrend = hh && hl ? 'bullish (higher highs and higher lows)' : !hh && !hl ? 'bearish (lower highs and lower lows)' : 'mixed (no clean sequence of highs and lows)';
  }

  const biasDir = dirOf(raw.bias && raw.bias.direction);
  const bias = {
    dir: biasDir, label: biasDir === 1 ? 'Bullish' : biasDir === -1 ? 'Bearish' : 'Neutral / mixed',
    why: str(raw.bias && raw.bias.why, 400), draw: str(raw.bias && raw.bias.draw, 200),
  };

  /* ---- the setup, re-checked ---- */
  const su = raw.setup || {};
  const dir = dirOf(su.direction);
  let state = /^ready/i.test(str(su.state)) ? 'in_zone' : /^pending/i.test(str(su.state)) ? 'pending' : /^await/i.test(str(su.state)) ? 'await_mss' : 'no_setup';
  const entryRaw = num(su.entry); const stopRaw = num(su.stop);
  const shift = num(su.shift_level);
  // the raid extreme: named explicitly, or implied by the stop that sits just beyond it
  const raidP = num(su.raid && su.raid.price) ?? (/^await/i.test(str(su.state)) ? num(su.stop) : null);
  const issues = [];
  let entry; let stop; let risk;
  const word = dir === 1 ? 'long' : 'short';
  if (dir !== 0 && (state === 'in_zone' || state === 'pending')) {
    if (!plausible(entryRaw) || !plausible(stopRaw)) issues.push('The AI gave an entry or stop that is not on the visible chart, so the trade was discarded.');
    else if (dir * (entryRaw - stopRaw) <= 0) issues.push(`The AI put the stop on the wrong side of the entry for a ${word}, so the trade was discarded.`);
    else if (Math.abs(entryRaw - stopRaw) < 4 * inst.tick) issues.push('Entry and stop are too close together to trade, so the trade was discarded.');
    else if ((dir * (last - entryRaw)) / Math.abs(entryRaw - stopRaw) <= -1) issues.push('Price is already beyond the stop the AI chose, so the trade was discarded.');
    else {
      entry = rt(entryRaw); stop = rt(stopRaw); risk = Math.abs(entry - stop);
      state = (dir * (last - entry)) / risk > 0.5 ? 'pending' : 'in_zone';
    }
    if (entry === undefined) state = 'no_setup';
  }
  let awaiting = null;
  if (dir !== 0 && state === 'await_mss') {
    if (plausible(shift) && plausible(stopRaw) && dir * (shift - last) > 0 && dir * (last - stopRaw) > 0) {
      awaiting = { dir, extreme: rt(stopRaw), mssLevel: rt(shift), swept: str(su.raid && su.raid.label, 80) || 'liquidity' };
    } else { issues.push("The AI's confirmation level did not fit the current price, so that pending idea was discarded."); state = 'no_setup'; }
  }
  if (dir === 0) state = 'no_setup';
  const tradable = entry !== undefined;
  const sDir = dir !== 0 ? dir : biasDir !== 0 ? biasDir : 1;
  const sWord = sDir === 1 ? 'long' : 'short';
  const ref = tradable ? entry : last;
  const same = Boolean(engine && engine.sameMarket);

  /* ---- checklist: same weights as the data engine ---- */
  const sc = raw.scores || {};
  const got = (k) => ({ pts: clamp(num(sc[k] && sc[k].pts) ?? 0, 0, W[k]), why: str(sc[k] && sc[k].why, 320) || 'No evidence given.' });
  const items = [];
  const put = (key, label, pts, detail) => items.push({ key, label, max: W[key], pts: Math.round(clamp(pts, 0, W[key]) * 10) / 10, detail });

  // higher-timeframe bias: exact from the price feed when it is the same market
  if (same) put('htf', 'Higher-timeframe bias (D / H4 / H1)', W.htf * clamp((sDir * engine.bias.sum) / 9, 0, 1), `From price data: bias score ${engine.bias.sum > 0 ? '+' : ''}${engine.bias.sum} of ±${engine.bias.max} → ${engine.bias.label}. ${sDir * engine.bias.sum > 0 ? `Supports ${sWord}s.` : `Does not support ${sWord}s.`} The chart itself reads ${bias.label.toLowerCase()}.`);
  else { const g = got('htf'); put('htf', 'Higher-timeframe bias', biasDir === -sDir ? 0 : g.pts, `${g.why} (Read from the picture only — add a Daily or H1 screenshot for a firmer bias.)`); }

  // room to the draw on liquidity
  const drawP = num(su.target_liquidity && su.target_liquidity.price);
  const draw = tradable && plausible(drawP) && dir * (drawP - entry) > 0 ? { label: str(su.target_liquidity.label, 80) || 'target liquidity', price: drawP, rr: Math.abs(drawP - entry) / risk } : null;
  if (draw) put('room', 'Draw on liquidity / room to target', W.room * clamp(draw.rr / 2.5, 0, 1), `Draw on liquidity: ${draw.label} at ${f(draw.price)} = ${draw.rr.toFixed(1)}R from the entry.`);
  else put('room', 'Draw on liquidity / room to target', 0, tradable ? 'No untouched liquidity target was read beyond the entry.' : 'Measured once there is an entry.');

  // premium / discount, computed from the range that was read
  if (range) {
    const pos = clamp((ref - range.lo) / (range.hi - range.lo), 0, 1);
    const cheap = sDir === 1 ? 1 - pos : pos;
    put('pd', 'Premium / discount', W.pd * clamp((cheap - 0.35) / 0.35, 0, 1), `${tradable ? 'Entry' : 'Price'} sits at ${Math.round(pos * 100)}% of the dealing range ${f(range.lo)}–${f(range.hi)} (${pos > 0.5 ? 'premium' : 'discount'}). ${sDir === 1 ? 'Longs belong in discount (<50%).' : 'Shorts belong in premium (>50%).'}`);
  } else put('pd', 'Premium / discount', 0, 'The dealing range could not be read from the chart.');

  // liquidity sweep
  {
    const g = got('sweep');
    const raidOk = plausible(raidP) && (state === 'no_setup' ? false : dir * (ref - raidP) > 0);
    if (state === 'no_setup') put('sweep', 'Liquidity sweep (stop raid)', 0, 'No raid of liquidity tied to a setup. ' + (swept.length ? `Sweeps seen on the chart: ${swept.map((x) => `${x.label} ${f(x.price)}`).join(', ')}.` : ''));
    else if (!raidOk) put('sweep', 'Liquidity sweep (stop raid)', 0, `The raid level the AI named is not on the stop side of a ${word}, so it does not count. ${g.why}`);
    else put('sweep', 'Liquidity sweep (stop raid)', g.pts, `${str(su.raid && su.raid.label, 80) || 'Liquidity'} raided at ${f(raidP)}. ${g.why}`);
  }
  // structure shift
  {
    const g = got('mss');
    const shiftOk = plausible(shift) && plausible(raidP) && dir * (shift - raidP) > 0;
    if (state === 'no_setup') put('mss', 'Market structure shift + displacement', 0, 'No shift in structure after a raid.');
    else if (state === 'await_mss') put('mss', 'Market structure shift + displacement', 0, `Not yet. Needs a candle close ${dir === 1 ? 'above' : 'below'} ${f(awaiting.mssLevel)}.`);
    else put('mss', 'Market structure shift + displacement', shiftOk ? g.pts : Math.min(g.pts, 6), `${shiftOk ? `Close ${dir === 1 ? 'above' : 'below'} ${f(shift)}. ` : 'The broken swing level was not given clearly, so this is capped. '}${g.why}`);
  }
  // entry array
  { const g = got('array'); put('array', 'Entry PD array', tradable ? g.pts : 0, tradable ? `${str(su.entry_array, 60) || 'Entry array'} at ${f(entry)}. ${g.why}` : 'No entry array tied to a raid and a shift.'); }

  // OTE, computed from the leg that was read
  {
    const from = num(su.leg && su.leg.from); const to = num(su.leg && su.leg.to);
    if (tradable && plausible(from) && plausible(to) && dir * (to - from) > 0) {
      const retr = (dir * (to - entry)) / Math.abs(to - from);
      const lo62 = to - dir * 0.62 * Math.abs(to - from); const lo79 = to - dir * 0.79 * Math.abs(to - from);
      put('ote', 'Optimal trade entry (62–79%)', retr >= 0.62 && retr <= 0.79 ? W.ote : retr >= 0.5 && retr <= 0.9 ? 2 : 0, `Entry is a ${Math.round(clamp(retr, 0, 9.99) * 100)}% retracement of the leg ${f(from)} → ${f(to)}. OTE zone: ${f(lo62)}–${f(lo79)}.`);
    } else put('ote', 'Optimal trade entry (62–79%)', 0, tradable ? 'The displacement leg could not be read, so OTE is not credited.' : 'Measured once there is an entry.');
  }
  { const tm = timeScore(session); put('time', 'Time of day (killzone)', tm.pts, tm.detail); }

  // indicators on the chart (they take the place SMT has in the data engine)
  {
    const agree = indicators.filter((i) => i.dir === sDir); const against = indicators.filter((i) => i.dir === -sDir);
    const n = indicators.length;
    put('smt', 'Indicators on your chart', n ? W.smt * clamp((agree.length - against.length) / n, 0, 1) : 0,
      n ? `${agree.length} of ${n} agree with a ${sWord}${agree.length ? ` (${agree.map((i) => i.name).join(', ')})` : ''}, ${against.length} against${against.length ? ` (${against.map((i) => i.name).join(', ')})` : ''}, ${n - agree.length - against.length} neutral.` : 'No indicators were found on the chart.');
  }
  // opening price and higher-timeframe order flow: exact when the feed is the same market
  if (same && engine.open) put('open', 'Opening price (Power of 3)', sDir * (engine.open.price - ref) > 0 ? W.open : 0, `${tradable ? 'Entry' : 'Price'} is ${ref < engine.open.price ? 'below' : 'above'} the ${engine.open.name} ${f(engine.open.price)} (from price data). ${sDir === 1 ? 'Longs are best taken below the open.' : 'Shorts are best taken above the open.'}`);
  else { const g = got('open'); put('open', 'Opening price (Power of 3)', g.pts, g.why); }
  if (same && engine.h1Trend !== undefined) put('h1', 'H1 order flow', engine.h1Trend === sDir ? W.h1 : 0, `H1 structure from price data is ${engine.h1Trend > 0 ? 'bullish' : engine.h1Trend < 0 ? 'bearish' : 'undefined'}.`);
  else { const g = got('h1'); put('h1', 'Higher-timeframe order flow', g.pts, g.why); }

  const ictPts = Math.round(items.reduce((x, y) => x + y.pts, 0) * 10) / 10;
  const nw = newsScores(sDir, news, inst.group);
  put('newsSentiment', 'News / world-event tone', nw.sentiment.pts, nw.sentiment.detail);
  put('newsCalendar', 'Economic calendar risk', nw.calendar.pts, nw.calendar.detail);
  const total = Math.round(items.reduce((x, y) => x + y.pts, 0) * 10) / 10;
  const pts = (k) => items.find((i) => i.key === k).pts;

  /* ---- decision: the same gates as the data engine ---- */
  const confidence = /^high/i.test(str(raw.confidence)) ? 'high' : /^low/i.test(str(raw.confidence)) ? 'low' : 'medium';
  let reason = null;
  if (tradable) {
    if (pts('sweep') === 0 || pts('mss') === 0) reason = 'The chart does not show both a liquidity raid and a structure shift — an ICT entry needs both.';
    else if (!draw) reason = 'No untouched liquidity target was read beyond the entry, so the trade cannot be validated. Every ICT trade needs a draw on liquidity.';
    else if (draw.rr < 1.5) reason = `The liquidity target (${draw.label} at ${f(draw.price)}) is only ${draw.rr.toFixed(1)}R from the entry — no room for a 1.5R trade.`;
    else if (range && pts('pd') === 0) reason = `This ${word} would be entered in ${dir === 1 ? 'premium' : 'discount'} — the wrong half of the dealing range.`;
    else if (same && dir * engine.bias.sum <= -4) reason = `This ${word} goes against the ${engine.bias.label.toLowerCase()} higher-timeframe bias from price data — ICT trades with the daily draw, not against it.`;
    else if (biasDir === -dir) reason = `This ${word} goes against the ${bias.label.toLowerCase()} bias read from the chart.`;
    else if (deadHours(session)) reason = deadHours(session);
    else if (nw.eventBlock) reason = 'High-impact news is about to print.';
    else if (confidence === 'low') reason = 'The AI was not confident in its reading of this chart. Use a clearer screenshot or add a higher-timeframe picture.';
    else if (total < MIN_SCORE) reason = `Confluence ${total}/100 is below the ${MIN_SCORE}-point minimum.`;
  } else if (issues.length) reason = issues[0];
  else if (state === 'await_mss') reason = 'Liquidity was raided but structure has not shifted yet.';
  else reason = 'No raid → shift → entry sequence is visible on this chart.';
  const go = tradable && !reason;

  const tfName = str(su.timeframe, 12) || arr(chart.timeframes).map((x) => str(x, 12)).filter(Boolean).pop() || 'chart';
  const plan = {
    action: go ? (dir === 1 ? 'LONG' : 'SHORT') : 'WAIT', dir: dir || biasDir, grade: tradable ? grade(total) : 'No trade', score: total, ictPts, newsPts: Math.round((total - ictPts) * 10) / 10,
    state, checklist: items, targets: [], reason, wait: [], tf: tfName, tags: [],
  };
  if (tradable) {
    const targets = RR_TARGETS.map((rr) => {
      const price = rt(entry + dir * rr * risk);
      const side = (dir === 1 ? above : below);
      const before = side.filter((p) => dir * (price - p.price) >= 0);
      const beyond = side.find((p) => dir * (p.price - price) > 0);
      const note = before.length ? `takes out ${before.slice(-2).map((p) => `${p.label} (${f(p.price)})`).join(' and ')}` : beyond ? `inside the range — next liquidity is ${beyond.label} at ${f(beyond.price)}` : 'no liquidity read beyond — R-multiple target only';
      return { rr, price, note, backed: draw ? rr <= draw.rr + 0.15 : false };
    });
    const backed = targets.filter((t) => t.backed);
    Object.assign(plan, {
      entry, stop, risk: rt(risk), riskUsd: Math.round(risk * inst.pointValue * 100) / 100, targets,
      preferred: (backed.length ? backed[backed.length - 1] : targets[0]).rr, entryType: str(su.entry_array, 40) || 'PD array',
      model: str(su.model, 60) || 'ICT raid → shift → entry', draw, stopReason: str(su.stop_reason, 200),
      orderType: state === 'pending' ? `${dir === 1 ? 'Buy' : 'Sell'} limit` : `${dir === 1 ? 'Buy' : 'Sell'} at market / limit at entry`,
    });
    plan.tags = [plan.model, plan.entryType, state === 'pending' ? 'Waiting for retrace' : 'Price at entry', `AI confidence: ${confidence}`];
  }
  if (awaiting) plan.setup = { ...awaiting, tf: tfName };
  const waitFor = str(su.wait_for, 500);
  if (!go && waitFor) plan.wait.push({ dir: dir || biasDir || 0, text: waitFor });

  const result = {
    mode: 'image',
    meta: {
      symbol: inst.key, name: inst.name, source: 'image', price: last, asOf: now, asOfText: fmtTime(now), decimals: inst.decimals, tick: inst.tick,
      pointValue: inst.pointValue, minScore: MIN_SCORE, weights: { ict: 87.5, news: 12.5 }, model: modelName, confidence, images: count,
      chartInstrument: str(chart.instrument, 80), timeframes: arr(chart.timeframes).map((x) => str(x, 12)).filter(Boolean), period: str(chart.period, 80),
      note: 'Read from your screenshot by an AI model. Prices taken from a picture are approximate — snap the entry and stop to the exact candle on your own chart.',
    },
    bias, session, range, plan, news: news || null,
    read: { indicators, candles: str(raw.candles, 900), trend: str(raw.structure && raw.structure.trend, 20), swingTrend, swings, events, above, below, swept, arrays, summary: str(raw.summary, 1200), problems: str(raw.problems, 300), issues },
    engine: engine || null,
  };
  if (engine && !same) result.meta.note += ` This chart (${f(last)}) does not look like ${inst.key} (${f(engine.price)} on the price feed): check that the right market is selected at the top. Position size and price rounding assume ${inst.key}.`;
  result.narrative = imageNarrative(result, { f, inst });
  return result;
}

function imageNarrative(r, { f, inst }) {
  const { plan, read, bias, session, range, news, meta, engine } = r;
  const sec = [];
  const add = (title, lines) => sec.push({ title, lines: lines.filter(Boolean) });
  const D = plan.dir === 1;

  const v = [];
  if (plan.action === 'WAIT') {
    v.push(`No trade right now. ${plan.reason || ''}`.trim());
    if (plan.entry !== undefined) v.push(`The closest candidate is a ${D ? 'long' : 'short'} from ${f(plan.entry)} (stop ${f(plan.stop)}), shown for reference only.`);
    if (plan.setup) v.push(`A ${plan.setup.dir === 1 ? 'long' : 'short'} is building: it becomes a trade after a candle closes ${plan.setup.dir === 1 ? 'above' : 'below'} ${f(plan.setup.mssLevel)}; the idea is dead ${plan.setup.dir === 1 ? 'below' : 'above'} ${f(plan.setup.extreme)}.`);
    for (const w of plan.wait) v.push(`What to wait for: ${w.text}`);
  } else {
    v.push(`${plan.action} ${meta.symbol} — grade ${plan.grade}, confluence ${plan.score}/100 (ICT ${plan.ictPts}/87.5, news ${plan.newsPts}/12.5).`);
    v.push(`${plan.orderType} at ${f(plan.entry)} (${plan.entryType}). Stop ${f(plan.stop)} — ${f(plan.risk)} of risk = $${plan.riskUsd.toFixed(2)} per ${meta.symbol} contract.`);
    v.push(`Targets: ${plan.targets.map((t) => `${t.rr}R ${f(t.price)}`).join(' · ')}. Preferred exit: ${plan.preferred}R.`);
  }
  if (read.summary) v.push(read.summary);
  add('1. Verdict', v);

  const c = [];
  c.push(`Chart read: ${meta.chartInstrument || 'instrument not shown'}${meta.timeframes.length ? `, timeframe ${meta.timeframes.join(' + ')}` : ''}${meta.period ? `, ${meta.period}` : ''}. Last price ${f(meta.price)}.`);
  if (read.candles) c.push(read.candles);
  if (read.indicators.length) for (const i of read.indicators) c.push(`${i.name}: ${i.reading}${i.dir ? ` → ${i.dir === 1 ? 'bullish' : 'bearish'}` : ''}.`);
  else c.push('No indicators were found on the chart — the analysis rests on price action alone.');
  c.push('Indicators are used as supporting evidence only. In ICT the decision comes from liquidity, structure and PD arrays.');
  if (read.problems) c.push(`Reading problems: ${read.problems}`);
  add('2. What your chart shows: candles and indicators', c);

  const h = [`Bias from the chart: ${bias.label}. ${bias.why}`.trim()];
  if (bias.draw) h.push(`Draw on liquidity: ${bias.draw}.`);
  if (engine && engine.sameMarket) {
    h.push(`Cross-check from price data (about 10 minutes late): ${engine.bias.label}, score ${engine.bias.sum > 0 ? '+' : ''}${engine.bias.sum} of ±${engine.bias.max}.`);
    for (const l of (engine.lines || []).slice(0, 7)) h.push(l);
    if (engine.plan) h.push(`Second opinion — the price-data engine on its own says ${engine.plan.action} (${engine.plan.score}/100)${engine.plan.entry !== undefined ? `, entry ${f(engine.plan.entry)}, stop ${f(engine.plan.stop)}` : ''}${engine.plan.reason ? `: ${engine.plan.reason}` : '.'}`);
  } else if (engine) h.push(`The price feed shows ${f(engine.price)}, which does not match this chart, so it was left out. Is the right market selected at the top?`);
  else h.push('No price-data cross-check was available. For a stronger bias, add a Daily or H1 screenshot next to the entry chart.');
  add('3. Higher-timeframe narrative and bias', h);

  const st = [read.trend ? `The AI reads the structure as ${read.trend}.` : null];
  if (read.swings.length) st.push(`Swing points read from the chart, oldest first: ${read.swings.map((x) => `${x.type} ${f(x.price)}${x.when ? ` (${x.when})` : ''}`).join(' → ')}.`);
  if (read.swingTrend) st.push(`Checked against those swing points: ${read.swingTrend}.`);
  for (const e of read.events) st.push(`${e.dir === 1 ? 'Bullish' : e.dir === -1 ? 'Bearish' : ''} ${e.type} at ${f(e.level)}${e.when ? ` (${e.when})` : ''}.`.trim());
  if (st.filter(Boolean).length === 0) st.push('No clear structure event could be read.');
  add('4. Market structure', st);

  const lst = (a) => a.map((p) => `${p.label} ${f(p.price)}`).join(' · ');
  add('5. Liquidity map', [
    read.above.length ? `Buy-side liquidity above price: ${lst(read.above)}.` : 'No buy-side liquidity read above price.',
    read.below.length ? `Sell-side liquidity below price: ${lst(read.below)}.` : 'No sell-side liquidity read below price.',
    read.swept.length ? `Recently swept: ${read.swept.map((p) => `${p.label} ${f(p.price)}${p.when ? ` (${p.when})` : ''}`).join(' · ')}.` : 'No recent sweep was identified.',
  ]);

  const pd = [];
  if (range) pd.push(`Dealing range ${f(range.lo)} – ${f(range.hi)}, equilibrium ${f(range.eq)}. Price is at ${Math.round(range.pos * 100)}% — ${range.pos > 0.5 ? 'premium (good for selling)' : 'discount (good for buying)'}.`);
  if (range) pd.push(`OTE for longs: ${f(range.hi - 0.62 * (range.hi - range.lo))} – ${f(range.hi - 0.79 * (range.hi - range.lo))}. OTE for shorts: ${f(range.lo + 0.62 * (range.hi - range.lo))} – ${f(range.lo + 0.79 * (range.hi - range.lo))}.`);
  for (const z of read.arrays) pd.push(`${z.dir === 1 ? 'Bullish' : z.dir === -1 ? 'Bearish' : ''} ${z.type} ${f(z.low)} – ${f(z.high)}${z.note ? ` — ${z.note}` : ''}.`.trim());
  if (!pd.length) pd.push('No open PD arrays could be read from the picture.');
  add('6. Premium / discount and PD arrays', pd);

  const t = [`New York time: ${session.nyTime}. ${session.killzone ? `Inside the ${session.killzone.name}.` : 'Outside the killzones.'}${session.silverBullet ? ` ${session.silverBullet.name} is open.` : ''}`];
  if (session.next) t.push(`Next window: ${session.next.name} at ${session.next.at} NY (in ${Math.floor(session.next.inMinutes / 60)}h ${session.next.inMinutes % 60}m).`);
  t.push('Time is judged from the clock when you pressed Analyze, so use a fresh screenshot.');
  add('7. Time: killzones', t);

  const e = [];
  if (plan.entry !== undefined) {
    e.push(`Entry: ${f(plan.entry)} at the ${plan.entryType}. Model: ${plan.model}.`);
    e.push(`Stop: ${f(plan.stop)}${plan.stopReason ? ` — ${plan.stopReason}` : ''}. If that level trades, the idea is wrong.`);
    for (const tp of plan.targets) e.push(`Target ${tp.rr}R = ${f(tp.price)} — ${tp.note}${tp.backed ? '' : ' (beyond the liquidity read on the chart: lower probability)'}.`);
  } else e.push('No complete entry is on the chart.');
  for (const i of read.issues) e.push(i);
  for (const w of plan.wait) e.push(`Next: ${w.text}`);
  add('8. Entry model', e);

  const n9 = [];
  if (!news) n9.push('News feed not loaded. The score treats news as neutral.');
  else {
    if (news.sentiment) n9.push(`Headline tone: ${news.sentiment.label} (${news.sentiment.method}). ${news.sentiment.summary || ''}`.trim());
    if (news.nextEvent) n9.push(`Next high-impact USD release: ${news.nextEvent.title} ${news.nextEvent.minutes >= 0 ? `in ${Math.floor(news.nextEvent.minutes / 60)}h ${news.nextEvent.minutes % 60}m` : 'just out'} (${news.nextEvent.when} NY).`);
    else n9.push(news.calendarOk ? 'No high-impact USD release left on the calendar window.' : 'Economic calendar could not be loaded — check it by hand.');
    n9.push('News carries 12.5% of the score. Trade the raid after the number, not the number.');
  }
  add('9. News and world events (12.5% weight)', n9);

  const k = [];
  if (plan.entry !== undefined) {
    k.push(`Risk per contract: ${f(plan.risk)} × $${inst.pointValue} = $${plan.riskUsd.toFixed(2)}. Size = (account risk in $) ÷ ${plan.riskUsd.toFixed(2)}, rounded down.`);
    k.push('Prices read from a picture can be a few ticks off. Before you place the order, move the entry and stop to the exact candle high or low on your own chart.');
    k.push('Management: take partials at 1.5R and move the stop to break-even.');
  }
  k.push('One setup per session. No trades in NY lunch (12:00–13:00) or within 30 minutes before a high-impact release.');
  add('10. Risk plan', k);
  return sec;
}

/** Merge: engine result (exact levels) + what the AI read from the picture. */
function fuse(e, v, { f, inst }) {
  const feed = e.meta.price;
  e.mode = 'fusion';
  Object.assign(e.meta, {
    source: 'image', feedPrice: feed, price: v.meta.price, model: v.meta.model, confidence: v.meta.confidence, images: v.meta.images,
    chartInstrument: v.meta.chartInstrument, chartTimeframes: v.meta.timeframes, period: v.meta.period,
    note: `Your screenshot was matched to ${inst.key} price data (your chart ${f(v.meta.price)}, data ${f(feed)} about 10 minutes late). The candle analysis is calculated from that data; the indicators, drawings and newest price are read from your picture by AI.`,
  });
  const agree = v.bias.dir === 0 || e.bias.dir === 0 ? null : v.bias.dir === e.bias.dir;
  e.vision = {
    read: v.read, bias: v.bias, agree,
    plan: { action: v.plan.action, score: v.plan.score, entry: v.plan.entry, stop: v.plan.stop, reason: v.plan.reason, wait: v.plan.wait },
  };
  const sec = v.narrative.find((s) => s.title.startsWith('2.'));
  const lines = sec ? [...sec.lines] : [];
  if (agree === true) lines.push(`Read from the picture alone, the AI leans ${v.bias.label.toLowerCase()} — the same side as the price data.`);
  if (agree === false) lines.push(`Read from the picture alone, the AI leans ${v.bias.label.toLowerCase()}, while the price data across Daily to M1 is ${e.bias.label.toLowerCase()}. One picture shows one timeframe, so the data decides — but treat the disagreement as a reason for caution.`);
  if (v.read.summary) lines.push(`AI summary of the picture: ${v.read.summary}`);
  e.narrative.splice(1, 0, { title: 'Your screenshot: candles and indicators (read by AI)', lines });
  return e;
}

/* ------------------------------- entry -------------------------------- */

/** Compact numeric context from the data engine, for the prompt and the cross-check. */
function engineContext(r, f) {
  const L = r.levels;
  const lines = [];
  lines.push(`Feed last price ${f(r.meta.price)} (${r.meta.asOfText} New York).`);
  lines.push(`Higher-timeframe bias: ${r.bias.label} (${r.bias.votes.map((v) => `${v.label} ${v.v > 0 ? '+' : ''}${v.v}`).join(', ')}).`);
  if (L.pdh !== null) lines.push(`Previous day high ${f(L.pdh)}, low ${f(L.pdl)}. Today so far: high ${f(L.dayHigh)}, low ${f(L.dayLow)}.`);
  if (L.pwh !== null) lines.push(`Previous week high ${f(L.pwh)}, low ${f(L.pwl)}.`);
  const o = L.opens;
  const ol = [o.midnight && `midnight ${f(o.midnight.price)}`, o.o830 && `08:30 ${f(o.o830.price)}`, o.daily && `daily 18:00 ${f(o.daily.price)}`].filter(Boolean);
  if (ol.length) lines.push(`Opening prices: ${ol.join(', ')}.`);
  const ses = L.sessions.filter((s) => s.done).slice(-3).map((s) => `${s.name} ${f(s.lo)}–${f(s.hi)}`);
  if (ses.length) lines.push(`Latest session ranges: ${ses.join('; ')}.`);
  if (r.liquidity.above.length) lines.push(`Untouched buy-side liquidity above: ${r.liquidity.above.slice(0, 4).map((p) => `${p.label} ${f(p.price)}`).join('; ')}.`);
  if (r.liquidity.below.length) lines.push(`Untouched sell-side liquidity below: ${r.liquidity.below.slice(0, 4).map((p) => `${p.label} ${f(p.price)}`).join('; ')}.`);
  if (r.range) lines.push(`H1 dealing range ${f(r.range.lo)}–${f(r.range.hi)}, price at ${Math.round(r.range.pos * 100)}%.`);
  return lines;
}

async function analyzeImages({ inst, images, notes, llm, news, engineResult, rerun, now = Math.floor(Date.now() / 1000) }) {
  if (!Array.isArray(images) || !images.length) throw new Error('Add at least one chart screenshot.');
  if (images.length > 4) throw new Error('Use at most 4 screenshots.');
  for (const u of images) if (typeof u !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(u)) throw new Error('Screenshots must be PNG, JPEG or WebP pictures.');
  const f = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: inst.decimals, maximumFractionDigits: inst.decimals });
  const session = sessionInfo(now);
  const lines = engineResult ? engineContext(engineResult, f) : null;
  const prompt = buildPrompt({ inst, session, notes, count: images.length, context: lines, news });
  const raw = await callVision({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, images, prompt });
  let engine = null;
  if (engineResult) {
    const last = num(raw.chart && raw.chart.last_price);
    const diff = last === null ? null : Math.abs(last - engineResult.meta.price) / engineResult.meta.price;
    const o = engineResult.levels.opens;
    const ep = engineResult.plan;
    engine = {
      bias: { dir: engineResult.bias.dir, label: engineResult.bias.label, sum: engineResult.bias.sum, max: engineResult.bias.max },
      price: engineResult.meta.price, lines: lines.slice(2), priceMatches: diff === null ? null : diff <= 0.005, sameMarket: diff !== null && diff <= 0.02,
      open: o.midnight ? { name: 'midnight open', price: o.midnight.price } : o.daily ? { name: 'daily open (18:00)', price: o.daily.price } : null,
      h1Trend: engineResult.chart.H1 ? engineResult.chart.H1.trend : undefined,
      plan: { action: ep.action, score: ep.score, state: ep.state, entry: ep.entry, stop: ep.stop, reason: ep.reason },
    };
  }
  const seen = buildResult(raw, { inst, now, news, engine, modelName: llm.model, count: images.length });
  // Same market as the price data: let the exact engine do the candle maths and
  // add what only the picture has (indicators, drawings, the newest price).
  if (engine && engine.priceMatches && typeof rerun === 'function') {
    try {
      const exact = await rerun({ indicators: seen.read.indicators.map(({ name, dir }) => ({ name, dir })), livePrice: seen.meta.price });
      return fuse(exact, seen, { f, inst });
    } catch { /* fall back to the picture-only reading */ }
  }
  return seen;
}

module.exports = { PROVIDERS, analyzeImages, buildPrompt, buildResult, callVision, extractJson, SYSTEM };
