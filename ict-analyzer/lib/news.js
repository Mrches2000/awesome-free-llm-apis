'use strict';
// News and world events: economic calendar + headlines. This is the 12.5% slice of
// the score. Everything here is optional — if a feed is down the score goes neutral.

const { fmtTime } = require('./time');

const CAL_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const UA = process.env.ICT_USER_AGENT || 'Mozilla/5.0 (compatible; ict-analyzer/1.0)';
const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (hit) return hit.value; // serve stale rather than nothing
    throw err;
  }
}

async function get(url, ms = 12000) {
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(ms) }); }
  catch (err) { throw new Error(`cannot reach ${new URL(url).host} (${(err.cause && err.cause.code) || err.name})`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

const QUERIES = {
  gold: 'gold price OR "gold prices" OR XAUUSD OR "Federal Reserve" OR "safe haven" when:1d',
  nasdaq: 'Nasdaq OR "Wall Street" OR "tech stocks" OR "Federal Reserve" OR "stock market" when:1d',
};

// [pattern, weight]. Positive = bullish for that market.
const LEX = {
  gold: [
    [/gold (price[s]? )?(rise|rises|rose|gain|gains|jump|jumps|surge|surges|climb|climbs|rall(y|ies)|soar|soars|hits? (a )?(record|high)|higher|advance|rebound)/i, 2],
    [/gold (price[s]? )?(fall|falls|fell|slip|slips|drop|drops|tumble|tumbles|slide|slides|retreat|retreats|plunge|plunges|lower|sink|sinks|declin|dip|dips|ease|eases)/i, -2],
    [/record high|all-time high|safe[- ]haven (demand|buying|bid)|central bank(s)? (buy|buying|purchases)/i, 1.5],
    [/rate cut|cuts rates|dovish|easing|weaker dollar|dollar (falls|slips|weakens|slides|drops)|yields (fall|drop|slip|slide|retreat)/i, 1.2],
    [/war|conflict|tension|escalat|geopolitic|sanction|attack|missile|crisis|shutdown|recession fear|tariff/i, 0.8],
    [/rate hike|hawkish|higher for longer|stronger dollar|dollar (rises|gains|strengthens|jumps|rallies|climbs)|yields (rise|climb|jump|surge|spike)/i, -1.2],
    [/ceasefire|peace deal|truce|risk[- ]on|profit[- ]taking/i, -0.8],
  ],
  nasdaq: [
    [/(stocks|nasdaq|wall street|tech|shares|futures|market[s]?) (rise|rises|rose|gain|gains|jump|jumps|surge|surges|climb|climbs|rall(y|ies)|soar|soars|rebound|rebounds|advance|higher|hit[s]? (a )?record)/i, 2],
    [/(stocks|nasdaq|wall street|tech|shares|futures|market[s]?) (fall|falls|fell|slip|slips|drop|drops|tumble|tumbles|slide|slides|sink|sinks|plunge|plunges|slump|slumps|lower|sell[- ]?off|retreat|declin)/i, -2],
    [/record high|all-time high|beats (estimates|expectations)|strong earnings|upbeat|optimis|rate cut|cuts rates|dovish|soft landing|cooling inflation|inflation (cools|eases|slows)|trade deal|ceasefire/i, 1.2],
    [/sell[- ]?off|rout|crash|bear market|correction|recession|misses (estimates|expectations)|profit warning|downgrade|layoffs|bubble/i, -1.3],
    [/rate hike|hawkish|higher for longer|hot inflation|inflation (jumps|rises|accelerates|surges)|yields (rise|climb|jump|surge|spike)|tariff|trade war|sanction|shutdown|war |conflict|escalat|attack/i, -1],
  ],
};

function parseRss(xml) {
  const items = [];
  const dec = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => { const x = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return x ? dec(x[1]).trim() : ''; };
    const title = pick('title');
    const source = pick('source');
    const t = Date.parse(pick('pubDate')) / 1000;
    if (title && Number.isFinite(t)) items.push({ title: source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title, source, t, link: pick('link') });
  }
  return items.sort((a, b) => b.t - a.t);
}

function keywordSentiment(headlines, group, now) {
  let num = 0; let den = 0;
  const drivers = [];
  for (const h of headlines) {
    let s = 0;
    for (const [re, w] of LEX[group]) if (re.test(h.title)) s += w;
    h.score = Math.max(-2, Math.min(2, s));
    const ageH = Math.max(0, (now - h.t) / 3600);
    const weight = Math.exp(-ageH / 10); // newer headlines count more
    den += weight;
    num += weight * (h.score / 2);
    if (h.score !== 0) drivers.push(h);
  }
  const hits = drivers.length;
  // shrink toward neutral when only a few headlines carry a signal
  const raw = den ? num / den : 0;
  const score = Math.max(-1, Math.min(1, raw * 2.2 * Math.min(1, hits / 6)));
  return { score, hits, method: `keyword scan of ${headlines.length} headlines` };
}

const label = (s) => (s >= 0.35 ? 'Clearly bullish' : s >= 0.12 ? 'Mildly bullish' : s <= -0.35 ? 'Clearly bearish' : s <= -0.12 ? 'Mildly bearish' : 'Neutral / mixed');

/** Optional: let any OpenAI-compatible model (many are free) judge the headlines. */
async function llmSentiment(headlines, group) {
  const key = process.env.LLM_API_KEY;
  const base = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL;
  if (!key || !base || !model || !headlines.length) return null;
  const market = group === 'gold' ? 'gold futures (GC)' : 'Nasdaq-100 futures (NQ)';
  const body = {
    model, temperature: 0,
    messages: [
      { role: 'system', content: 'You are a macro news analyst. Reply with JSON only.' },
      { role: 'user', content: `Headlines from the last 24h:\n${headlines.slice(0, 40).map((h, i) => `${i + 1}. ${h.title}`).join('\n')}\n\nJudge the net short-term (intraday to 2 days) directional pressure on ${market}. Reply as JSON: {"score": number from -1 (bearish) to 1 (bullish), "summary": "two sentences naming the main drivers"}` },
    ],
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const txt = (await res.json()).choices[0].message.content;
  const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const score = Math.max(-1, Math.min(1, Number(j.score)));
  if (!Number.isFinite(score)) throw new Error('LLM returned no score');
  return { score, summary: String(j.summary || '').slice(0, 500), method: `AI reading of ${Math.min(40, headlines.length)} headlines (${model})` };
}

async function getNews(group, now = Math.floor(Date.now() / 1000)) {
  const out = { calendarOk: false, headlinesOk: false, events: [], nextEvent: null, headlines: [], sentiment: null, errors: [] };
  const [cal, rss] = await Promise.allSettled([
    cached('cal', 30 * 60000, async () => JSON.parse(await get(CAL_URL))),
    cached(`rss:${group}`, 10 * 60000, async () => parseRss(await get(`https://news.google.com/rss/search?q=${encodeURIComponent(QUERIES[group])}&hl=en-US&gl=US&ceid=US:en`))),
  ]);
  if (cal.status === 'fulfilled' && Array.isArray(cal.value)) {
    out.calendarOk = true;
    out.events = cal.value
      .filter((e) => (e.country === 'USD' || e.country === 'All') && (e.impact === 'High' || e.impact === 'Medium'))
      .map((e) => { const t = Date.parse(e.date) / 1000; return { title: e.title, impact: e.impact, t, minutes: Math.round((t - now) / 60), when: fmtTime(t), forecast: e.forecast, previous: e.previous }; })
      .filter((e) => Number.isFinite(e.t) && e.minutes >= -180 && e.minutes <= 3 * 1440)
      .sort((a, b) => a.t - b.t);
    out.nextEvent = out.events.find((e) => e.impact === 'High' && e.minutes >= -5) || null;
  } else out.errors.push(`Calendar: ${cal.reason ? cal.reason.message : 'bad response'}`);
  if (rss.status === 'fulfilled') {
    out.headlinesOk = true;
    const hl = rss.value.filter((h) => now - h.t < 36 * 3600).slice(0, 60).map((h) => ({ ...h }));
    let s = keywordSentiment(hl, group, now);
    try { const ai = await cached(`llm:${group}`, 10 * 60000, () => llmSentiment(hl, group)); if (ai) s = { ...s, ...ai }; }
    catch (err) { out.errors.push(`AI news reading failed (${err.message}); used keyword scan.`); }
    const top = hl.filter((h) => h.score).sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.t - a.t).slice(0, 3);
    out.sentiment = { ...s, label: label(s.score), summary: s.summary || (top.length ? `Main drivers: ${top.map((h) => `“${h.title}”`).join('; ')}.` : 'No strong directional headlines.') };
    out.headlines = hl.slice(0, 14).map((h) => ({ title: h.title, source: h.source, t: h.t, when: fmtTime(h.t), score: h.score || 0, link: h.link }));
  } else out.errors.push(`Headlines: ${rss.reason ? rss.reason.message : 'bad response'}`);
  return out;
}

module.exports = { getNews, parseRss, keywordSentiment };
