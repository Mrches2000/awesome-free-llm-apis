/* Page logic: fetch an analysis and render it. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  const SYMBOLS = [['MNQ', 'Micro Nasdaq'], ['MGC', 'Micro Gold'], ['NQ', 'Nasdaq'], ['GC', 'Gold']];
  const LAYERS = [['fvg', 'Fair value gaps'], ['ob', 'Order blocks'], ['liq', 'Liquidity'], ['structure', 'Structure'], ['sessions', 'Killzones'], ['plan', 'Trade plan']];
  const TF_ORDER = ['D', 'H4', 'H1', 'M15', 'M5', 'M1'];
  const state = { symbol: store.get('ict.symbol', 'MNQ'), tf: null, data: null, csv: null, timer: null, busy: false, shots: [], providers: [], ai: null };
  const chart = new window.IctChart($('chart'), $('tip'));

  /* ---------- controls ---------- */
  function segButtons(el, items, current, onPick) {
    el.innerHTML = items.map(([k, label]) => `<button data-k="${esc(k)}" class="${k === current ? 'on' : ''}" title="${esc(label)}">${esc(k)}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; onPick(b.dataset.k); };
  }
  function drawSymbols() { segButtons($('symbols'), SYMBOLS, state.symbol, (k) => { state.symbol = k; store.set('ict.symbol', k); drawSymbols(); run(); }); }
  drawSymbols();
  $('layers').innerHTML = LAYERS.map(([k, label]) => `<button data-k="${k}" class="on">${label}</button>`).join('');
  $('layers').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; chart.layers[b.dataset.k] = !chart.layers[b.dataset.k]; b.classList.toggle('on'); chart.draw(); };
  $('source').value = store.get('ict.source', 'image');
  const syncSource = () => { const v = $('source').value; $('csvWrap').hidden = v !== 'csv'; $('uploader').hidden = v !== 'image'; };
  syncSource();
  $('source').onchange = () => { store.set('ict.source', $('source').value); syncSource(); const v = $('source').value; if (v === 'live' || v === 'demo' || (v === 'csv' && state.csv)) run(); };
  $('csv').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; state.csv = await f.text(); $('csvName').textContent = f.name; run(); };
  $('run').onclick = () => run();
  $('auto').onchange = () => { clearInterval(state.timer); if ($('auto').checked) state.timer = setInterval(() => { if (['live', 'demo'].includes($('source').value)) run(true); }, 60000); };

  function banner(kind, html) { const b = $('banner'); b.hidden = !html; b.className = `banner ${kind || ''}`; b.innerHTML = html || ''; }

  async function run(quiet) {
    if (state.busy) return;
    const source = $('source').value;
    if (source === 'csv' && !state.csv) { banner('warn', 'Choose a CSV file first. In TradingView: open your chart on 1 or 5 minutes → menu next to the layout name → <b>Export chart data…</b>'); return; }
    if (source === 'image' && !state.shots.length) { banner('warn', 'Add a screenshot of your chart first: drop it in the box above, paste it, or choose a picture.'); return; }
    state.busy = true; $('run').disabled = true; $('run').textContent = source === 'image' ? 'AI is reading your chart… (up to a minute)' : 'Analyzing…';
    try {
      const res = source === 'image'
        ? await fetch('/api/analyze-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: state.symbol, images: state.shots, notes: $('notes').value, llm: aiRequest() }) })
        : source === 'csv'
        ? await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: state.symbol, csv: state.csv }) })
        : await fetch(`/api/analyze?symbol=${encodeURIComponent(state.symbol)}&source=${source}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      state.data = data;
      render(!quiet);
    } catch (err) {
      banner('err', `<b>Could not analyze:</b> ${esc(err.message)}${source === 'live' ? ' — you can switch Data to “My CSV export” or “Demo”.' : ''}`);
    } finally {
      state.busy = false; $('run').disabled = false; $('run').textContent = 'Analyze';
    }
  }

  /* ---------- rendering ---------- */
  const fmtP = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: state.data.meta.decimals, maximumFractionDigits: state.data.meta.decimals });
  const usd = (x) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function render(resetTf) {
    const d = state.data; const m = d.meta;
    $('empty').hidden = true; $('app').hidden = false;
    const mode = d.mode || 'data';
    if (mode === 'image') return renderImageOnly();
    const old = m.source === 'csv' && m.ageMin > 30;
    const kind = m.source === 'demo' || m.stale || old ? 'warn' : '';
    banner(kind, `<b>${esc(m.symbol)} · ${esc(m.name)}</b> — ${mode === 'fusion' ? 'price on your chart' : 'last price'} <b>${fmtP(m.price)}</b> as of ${esc(m.asOfText)} New York. ${esc(m.note || '')}${m.stale ? ' <b>The market looks closed or the feed is behind.</b>' : ''}${old ? ` <b>This file ends ${m.ageMin > 2880 ? Math.round(m.ageMin / 1440) + ' days' : m.ageMin > 120 ? Math.round(m.ageMin / 60) + ' hours' : m.ageMin + ' minutes'} ago — the levels describe that moment, not now.</b>` : ''}`);
    const tfs = TF_ORDER.filter((t) => d.chart[t]);
    if (resetTf || !tfs.includes(state.tf)) state.tf = d.plan.tf && tfs.includes(d.plan.tf) ? d.plan.tf : tfs.includes('M5') ? 'M5' : tfs[tfs.length - 1];
    const drawTfs = () => segButtons($('tfs'), tfs.map((t) => [t, t]), state.tf, (k) => { state.tf = k; drawTfs(); setChart(); });
    $('chartBox').hidden = false; $('galleryHere').innerHTML = '';
    drawTfs(); setChart();
    renderVerdict(); renderSizer(); renderChecklist(); renderContext(); renderNarrative(); renderNews();
    $('visionRow').hidden = mode !== 'fusion';
    if (mode === 'fusion') { $('shotPanel').hidden = false; $('galleryThere').innerHTML = gallery(); renderAiRead(); }
  }

  /* ---------- screenshot mode ---------- */
  const gallery = () => `<div class="gallery">${state.shots.map((u, i) => `<img src="${u}" alt="Chart screenshot ${i + 1}">`).join('')}</div>`;

  // The picture could not be matched to price data: everything comes from the AI's reading.
  function renderImageOnly() {
    const d = state.data; const m = d.meta;
    banner('warn', `<b>${esc(m.symbol)} · ${esc(m.name)}</b> — price on your chart <b>${fmtP(m.price)}</b> (read at ${esc(m.asOfText)} New York). ${esc(m.note || '')}`);
    $('chartBox').hidden = true; $('galleryHere').innerHTML = gallery();
    $('visionRow').hidden = false; $('shotPanel').hidden = true;
    renderVerdict(); renderSizer(); renderChecklist(); renderContextImage(); renderNarrative(); renderNews(); renderAiRead();
  }

  function renderAiRead() {
    const d = state.data; const m = d.meta;
    const v = d.mode === 'fusion' ? d.vision : { read: d.read, bias: d.bias };
    const r = v.read;
    $('aiModelLine').textContent = `${m.model} · confidence ${m.confidence}`;
    let h = `<p class="aiP"><b>${esc(m.chartInstrument || 'Chart')}</b>${(m.chartTimeframes || m.timeframes || []).length ? ` · ${esc((m.chartTimeframes || m.timeframes).join(' + '))}` : ''}${m.period ? ` · ${esc(m.period)}` : ''}</p>`;
    if (r.indicators.length) h += `<div class="ind">${r.indicators.map((i) => `<span class="chip ${i.dir === 1 ? 'b' : i.dir === -1 ? 's' : 'n'}">${i.dir === 1 ? 'bullish' : i.dir === -1 ? 'bearish' : 'neutral'}</span><span><b>${esc(i.name)}</b> — ${esc(i.reading)}</span>`).join('')}</div>`;
    else h += '<p class="aiP muted">No indicators were found on the picture.</p>';
    if (r.candles) h += `<p class="aiP"><b>Candles.</b> ${esc(r.candles)}</p>`;
    if (r.summary) h += `<p class="aiP"><b>AI summary.</b> ${esc(r.summary)}</p>`;
    if (r.problems) h += `<p class="aiP muted">Reading problems: ${esc(r.problems)}</p>`;
    if (d.mode === 'fusion') {
      const a = v.agree;
      h += `<div class="aiBox">Picture alone: the AI leans <b class="${v.bias.dir === 1 ? 'up' : v.bias.dir === -1 ? 'dn' : 'am'}">${esc(v.bias.label)}</b>${a === true ? ' — agrees with the price data.' : a === false ? ` — <b>disagrees</b> with the price data (${esc(d.bias.label)}). The data covers Daily to M1, so it decides; treat the disagreement as a caution.` : '.'} The entry, stop and targets above come from the exact price data, not from pixel reading.</div>`;
    } else h += '<div class="aiBox">These levels were read from the picture by the AI and then checked by the program. They can be a few ticks off — confirm them on your own chart.</div>';
    $('aiRead').innerHTML = h;
  }

  function renderContextImage() {
    const d = state.data; const { bias, session: s, range, read } = d;
    const cls = bias.dir === 1 ? 'up' : bias.dir === -1 ? 'dn' : 'am';
    const rows = (arr) => arr.slice(0, 4).map((p) => `<tr><td>${esc(p.label)}</td><td>${fmtP(p.price)}</td></tr>`).join('') || '<tr><td class="muted">none read</td><td></td></tr>';
    let h = '<div class="ctx">';
    h += `<div class="card"><div class="k">Bias read from the chart</div><div class="v ${cls}">${esc(bias.label)}</div><div class="s">${esc(bias.why)}</div></div>`;
    h += `<div class="card"><div class="k">Session (New York time)</div><div class="v">${esc(s.nyTime)}</div><div class="s">${esc(s.killzone ? s.killzone.name : 'Outside killzones')}${s.next ? ` · next: ${esc(s.next.name)} ${esc(s.next.at)}` : ''}</div></div>`;
    if (range) h += `<div class="card"><div class="k">Premium / discount</div><div class="v ${range.pos > 0.5 ? 'dn' : 'up'}">${Math.round(range.pos * 100)}% — ${range.pos > 0.5 ? 'Premium' : 'Discount'}</div><div class="pdbar"><i style="left:${Math.round(range.pos * 100)}%"></i></div><div class="s">${fmtP(range.lo)} · EQ ${fmtP(range.eq)} · ${fmtP(range.hi)}</div></div>`;
    h += `<div class="card"><div class="k">Structure</div><div class="s">${esc(read.swingTrend || read.trend || 'not readable')}${read.events.map((e) => `<br>${e.dir === 1 ? '<span class="up">▲</span>' : e.dir === -1 ? '<span class="dn">▼</span>' : ''} ${esc(e.type)} ${fmtP(e.level)}`).join('')}</div></div>`;
    h += `<div class="card"><div class="k">Buy-side liquidity above</div><table class="liqT">${rows(read.above)}</table></div>`;
    h += `<div class="card"><div class="k">Sell-side liquidity below</div><table class="liqT">${rows(read.below)}</table></div>`;
    h += `<div class="card"><div class="k">PD arrays read</div><div class="s">${read.arrays.map((z) => `${z.dir === 1 ? '<span class="up">Bullish</span>' : z.dir === -1 ? '<span class="dn">Bearish</span>' : ''} ${esc(z.type)} ${fmtP(z.low)}–${fmtP(z.high)}`).join('<br>') || 'none read'}</div></div>`;
    h += `<div class="card"><div class="k">Price-data cross-check</div><div class="s">${d.engine ? (d.engine.sameMarket ? `Bias ${esc(d.engine.bias.label)} — used for the score.` : `Feed price ${fmtP(d.engine.price)} does not match this chart. Is the right market selected?`) : 'Not available — add a Daily or H1 screenshot for a firmer bias.'}</div></div>`;
    $('context').innerHTML = `${h}</div>`;
  }

  function setChart() {
    const d = state.data;
    chart.setData(d.chart[state.tf], { pools: d.pools, plan: d.plan, opens: d.levels.opens, decimals: d.meta.decimals });
  }

  function renderVerdict() {
    const { plan: p, meta: m, bias } = state.data;
    const has = p.entry !== undefined;
    const act = p.action;
    const head = act === 'WAIT' ? 'No trade — wait' : `${act === 'LONG' ? 'Buy' : 'Sell'} ${m.symbol}`;
    let h = `<div class="head"><span class="badge ${act}">${act}</span><div class="sub"><b>${esc(head)}</b><br>Grade ${esc(p.grade)} · bias ${esc(bias.label)}</div></div>`;
    h += `<div class="meter"><i class="ict" style="width:${p.ictPts}%"></i><i class="news" style="width:${p.newsPts}%"></i></div>`;
    h += `<div class="meterLbl"><span>Confluence <b>${p.score}</b>/100 (trade needs ${m.minScore})</span><span>ICT ${p.ictPts} · news ${p.newsPts}</span></div>`;
    if (p.reason) h += `<div class="why">${esc(p.reason)}</div>`;
    if (has) {
      const s = p.setup;
      h += `<table class="lv ${act === 'WAIT' ? 'ref' : ''}">`;
      h += `<tr class="entry"><td>${act === 'WAIT' ? 'Reference entry' : esc(p.orderType)}</td><td>${fmtP(p.entry)}</td><td>${esc(p.entryType)} · ${esc(p.tf)}</td></tr>`;
      h += `<tr class="stop"><td>Stop loss</td><td>${fmtP(p.stop)}</td><td>−${fmtP(p.risk)} · ${usd(p.riskUsd)}</td></tr>`;
      for (const t of p.targets) h += `<tr class="tp ${t.rr === p.preferred ? 'pref' : ''}"><td>Target ${t.rr}R</td><td>${fmtP(t.price)}</td><td>+${usd(p.riskUsd * t.rr)}</td></tr>`;
      h += '</table>';
      const tags = p.tags && p.tags.length ? [...p.tags] : [p.model, s.ote ? 'Inside OTE' : `${Math.round(s.retr * 100)}% retracement`, s.mssDisp ? 'Displacement' : 'Weak displacement', s.stopKind === 'raid' ? 'Stop beyond raid' : 'Tight stop'];
      if (s && s.silverBullet) tags.push('Silver Bullet window');
      h += `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
      h += `<p class="note">★ = preferred exit (furthest target with liquidity behind it). $ figures are per ${esc(m.symbol)} contract.</p>`;
    }
    if (!has && p.state === 'await_mss' && p.setup) {
      const s = p.setup; const up = s.dir === 1;
      h += `<table class="lv"><tr><td>Building</td><td class="${up ? 'up' : 'dn'}">${up ? 'LONG' : 'SHORT'}</td><td>${esc(s.tf)}</td></tr>`;
      h += `<tr><td>Liquidity raided</td><td>${fmtP(s.extreme)}</td><td>${esc(s.swept.split(',')[0])}</td></tr>`;
      h += `<tr class="entry"><td>Becomes a trade on a ${esc(s.tf)} close ${up ? 'above' : 'below'}</td><td>${fmtP(s.mssLevel)}</td><td>structure shift</td></tr>`;
      h += `<tr class="stop"><td>Idea is dead ${up ? 'below' : 'above'}</td><td>${fmtP(s.extreme)}</td><td>raid ${up ? 'low' : 'high'}</td></tr></table>`;
      h += '<p class="note">After the shift, press Analyze again: the entry gap, stop and 1.5R / 2R / 2.5R targets will appear here.</p>';
    }
    if (p.wait && p.wait.length) h += p.wait.map((w) => `<div class="why"><b class="${w.dir === 1 ? 'up' : 'dn'}">${w.dir === 1 ? 'Long' : 'Short'} scenario.</b> ${esc(w.text.replace(/^(Long|Short) scenario: /, ''))}</div>`).join('');
    $('verdict').innerHTML = h;
  }

  function renderSizer() {
    const { plan: p, meta: m } = state.data;
    if (p.entry === undefined) { $('sizer').innerHTML = '<h2>Position size</h2><p class="muted">Appears when there is an entry and a stop.</p>'; return; }
    const risk = Number(store.get('ict.risk', '100')) || 100;
    $('sizer').innerHTML = `<h2>Position size</h2><div class="sz">
      <span class="k">I want to risk ($)</span><input id="riskIn" type="number" min="1" step="10" value="${risk}">
      <span class="k">Contracts (${esc(m.symbol)})</span><span class="big" id="szN"></span>
      <span class="k">Actual risk</span><span id="szR"></span>
      <span class="k">Profit at ${p.preferred}R</span><span id="szP" class="up"></span></div>
      <p class="note" id="szNote"></p>`;
    const calc = () => {
      const r = Math.max(0, Number($('riskIn').value) || 0); store.set('ict.risk', String(r));
      const n = Math.floor(r / p.riskUsd);
      $('szN').textContent = n;
      $('szR').textContent = usd(n * p.riskUsd);
      $('szP').textContent = `+${usd(n * p.riskUsd * p.preferred)}`;
      $('szNote').textContent = n === 0 ? `One contract risks ${usd(p.riskUsd)} on this stop — more than your limit. Skip the trade or use a smaller contract.` : `Stop distance ${fmtP(p.risk)} × $${m.pointValue} per point.`;
    };
    $('riskIn').oninput = calc; calc();
  }

  function renderChecklist() {
    const p = state.data.plan;
    $('scoreLine').textContent = `${p.score}/100 — ICT counts for 87.5%, news for 12.5%`;
    $('checklist').innerHTML = p.checklist.map((c) => {
      const r = c.max ? c.pts / c.max : 0;
      const cls = c.key.startsWith('news') ? 'nw' : r >= 0.66 ? '' : r >= 0.33 ? 'mid' : 'low';
      return `<div class="ck"><div><div class="t">${esc(c.label)}</div></div><div class="p">${c.pts} / ${c.max}<div class="bar ${cls}"><i style="width:${Math.round(r * 100)}%"></i></div></div><div class="d">${esc(c.detail)}</div></div>`;
    }).join('');
  }

  function renderContext() {
    const d = state.data; const { bias, session: s, range, liquidity, levels, smt } = d;
    const cls = bias.dir === 1 ? 'up' : bias.dir === -1 ? 'dn' : 'am';
    const liqRows = (arr) => arr.slice(0, 4).map((p) => `<tr><td>${p.strength >= 3 ? '★ ' : ''}${esc(p.label)}</td><td>${fmtP(p.price)}</td></tr>`).join('') || '<tr><td class="muted">none mapped</td><td></td></tr>';
    const tr = (t) => (t > 0 ? '<span class="up">▲</span>' : t < 0 ? '<span class="dn">▼</span>' : '<span class="am">–</span>');
    const o = levels.opens;
    let h = '<div class="ctx">';
    h += `<div class="card"><div class="k">Higher-timeframe bias</div><div class="v ${cls}">${esc(bias.label)}</div><div class="s">Score ${bias.sum > 0 ? '+' : ''}${bias.sum} / ±${bias.max} · ${['D', 'H4', 'H1', 'M15', 'M5'].filter((t) => d.chart[t]).map((t) => `${t} ${tr(d.chart[t].trend)}`).join(' ')}</div></div>`;
    h += `<div class="card"><div class="k">Session (New York time)</div><div class="v">${esc(s.nyTime)}</div><div class="s">${esc(s.killzone ? s.killzone.name : 'Outside killzones')}${s.silverBullet ? ' · Silver Bullet' : ''}${s.next ? ` · next: ${esc(s.next.name)} ${esc(s.next.at)}` : ''}</div></div>`;
    if (range) h += `<div class="card"><div class="k">Premium / discount (H1 range)</div><div class="v ${range.pos > 0.5 ? 'dn' : 'up'}">${Math.round(range.pos * 100)}% — ${range.pos > 0.5 ? 'Premium' : 'Discount'}</div><div class="pdbar"><i style="left:${Math.round(range.pos * 100)}%"></i></div><div class="s">${fmtP(range.lo)} · EQ ${fmtP(range.eq)} · ${fmtP(range.hi)}</div></div>`;
    h += `<div class="card"><div class="k">Opening prices</div><div class="s">${[['Midnight', o.midnight], ['08:30', o.o830], ['09:30', o.o930], ['Daily 18:00', o.daily], ['Weekly', o.weekly]].filter((x) => x[1]).map(([n, v]) => `${n} <b style="color:var(--text)">${fmtP(v.price)}</b> ${d.meta.price >= v.price ? '<span class="up">above</span>' : '<span class="dn">below</span>'}`).join('<br>')}</div></div>`;
    h += `<div class="card"><div class="k">Buy-side liquidity above</div><table class="liqT">${liqRows(liquidity.above)}</table></div>`;
    h += `<div class="card"><div class="k">Sell-side liquidity below</div><table class="liqT">${liqRows(liquidity.below)}</table></div>`;
    h += `<div class="card"><div class="k">Previous day / week</div><div class="s">PDH <b style="color:var(--text)">${levels.pdh !== null ? fmtP(levels.pdh) : '–'}</b> · PDL <b style="color:var(--text)">${levels.pdl !== null ? fmtP(levels.pdl) : '–'}</b><br>PWH <b style="color:var(--text)">${levels.pwh !== null ? fmtP(levels.pwh) : '–'}</b> · PWL <b style="color:var(--text)">${levels.pwl !== null ? fmtP(levels.pwl) : '–'}</b></div></div>`;
    h += `<div class="card"><div class="k">SMT vs ${esc(d.meta.smtName)}</div><div class="s">${smt === null ? 'Not available for this data source.' : smt.length ? smt.map((x) => `<span class="${x.dir === 1 ? 'up' : 'dn'}">${x.dir === 1 ? 'Bullish' : 'Bearish'}</span> divergence on ${esc(x.tf)} (${x.age} bars ago)`).join('<br>') : 'No divergence — both markets agree.'}</div></div>`;
    $('context').innerHTML = `${h}</div>`;
  }

  function renderNarrative() {
    $('narrative').innerHTML = state.data.narrative.map((s) => `<section><h3>${esc(s.title)}</h3><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>`).join('');
  }

  function renderNews() {
    const n = state.data.news;
    if (!n) { $('calendar').innerHTML = $('headlines').innerHTML = '<p class="muted">News could not be loaded. The score treats it as neutral.</p>'; $('tone').textContent = ''; return; }
    const ev = n.events.filter((e) => e.minutes >= -120).slice(0, 12);
    $('calendar').innerHTML = !n.calendarOk ? '<p class="muted">Calendar unavailable right now.</p>' : !ev.length ? '<p class="muted">No medium or high impact USD releases in the next three days.</p>'
      : `<table class="tbl">${ev.map((e) => `<tr class="${e.minutes >= -5 && e.minutes <= 60 ? 'soon' : ''}"><td class="when">${esc(e.when)}</td><td>${esc(e.title)}${e.forecast || e.previous ? `<div class="muted" style="font-size:12px">forecast ${esc(e.forecast || '–')} · previous ${esc(e.previous || '–')}</div>` : ''}</td><td><span class="imp ${esc(e.impact)}">${esc(e.impact)}</span></td><td class="when">${e.minutes < 0 ? 'released' : e.minutes < 60 ? `in ${e.minutes}m` : `in ${Math.floor(e.minutes / 60)}h ${e.minutes % 60}m`}</td></tr>`).join('')}</table>`;
    $('tone').textContent = n.sentiment ? `${n.sentiment.label} (${n.sentiment.score > 0 ? '+' : ''}${n.sentiment.score.toFixed(2)}) · ${n.sentiment.method}` : '';
    $('headlines').innerHTML = !n.headlinesOk ? '<p class="muted">Headlines unavailable right now.</p>'
      : `<table class="tbl hl">${n.headlines.map((h) => `<tr><td><span class="dot ${h.score > 0 ? 'p' : h.score < 0 ? 'n' : ''}" title="${h.score > 0 ? 'bullish' : h.score < 0 ? 'bearish' : 'neutral'} keyword"></span></td><td>${/^https?:\/\//.test(h.link) ? `<a href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>` : esc(h.title)}<div class="src">${esc(h.source)} · ${esc(h.when)}</div></td></tr>`).join('')}</table>`;
  }

  /* ---------- screenshots: add, paste, drop ---------- */
  function toDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Use a PNG, JPEG or WebP picture.'));
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read that file.'));
      r.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a picture.'));
        img.onload = () => {
          const k = Math.min(1, 2000 / Math.max(img.width, img.height));
          if (k === 1 && file.size < 1.5e6) return resolve(r.result);
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.92));
        };
        img.src = r.result;
      };
      r.readAsDataURL(file);
    });
  }
  function drawThumbs() {
    $('thumbs').innerHTML = state.shots.map((u, i) => `<div class="thumb"><img src="${u}" alt="Screenshot ${i + 1}"><button type="button" data-i="${i}" title="Remove" aria-label="Remove screenshot ${i + 1}">×</button></div>`).join('');
  }
  async function addFiles(files) {
    for (const f of files) {
      if (state.shots.length >= 4) { banner('warn', 'Four pictures is the maximum. Remove one to add another.'); break; }
      try { state.shots.push(await toDataUrl(f)); } catch (err) { banner('err', esc(err.message)); }
    }
    drawThumbs();
  }
  $('shots').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('thumbs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); e.stopPropagation(); state.shots.splice(Number(b.dataset.i), 1); drawThumbs(); };
  $('drop').onclick = (e) => { if (!e.target.closest('.thumb') && !e.target.closest('label')) $('shots').click(); };
  $('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('shots').click(); } };
  $('drop').ondragover = (e) => { e.preventDefault(); $('drop').classList.add('over'); };
  $('drop').ondragleave = () => $('drop').classList.remove('over');
  $('drop').ondrop = (e) => { e.preventDefault(); $('drop').classList.remove('over'); addFiles([...e.dataTransfer.files]); };
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    if ($('source').value !== 'image') { $('source').value = 'image'; store.set('ict.source', 'image'); syncSource(); }
    addFiles(files);
  });

  /* ---------- AI settings ---------- */
  const loadAi = () => { try { return JSON.parse(store.get('ict.ai', 'null')) || {}; } catch { return {}; } };
  state.ai = loadAi();
  const preset = () => state.providers.find((p) => p.id === (state.ai.provider || 'ovh')) || state.providers[0];
  function aiRequest() {
    const p = preset();
    if (!p) return null; // server falls back to its default
    if (p.id === 'custom') return { baseUrl: state.ai.baseUrl || '', model: state.ai.model || '', apiKey: state.ai.apiKey || '' };
    return { baseUrl: p.baseUrl, model: state.ai.model || p.models[0], apiKey: p.needsKey ? state.ai.apiKey || '' : '' };
  }
  function drawAiLine() {
    const p = preset();
    if (!p) { $('aiLine').textContent = ''; return; }
    const r = aiRequest();
    $('aiLine').textContent = `AI reader: ${p.name} · ${r.model || 'no model chosen'}${p.needsKey && !r.apiKey ? ' — needs a key: open AI settings' : ''}`;
  }
  function fillAiDialog() {
    const id = $('aiProvider').value; const p = state.providers.find((x) => x.id === id);
    const custom = id === 'custom';
    $('aiHint').textContent = p.hint || '';
    $('aiUrlWrap').hidden = !custom; $('aiModelCustomWrap').hidden = !custom;
    $('aiModel').parentElement.hidden = custom;
    $('aiModel').innerHTML = p.models.map((m) => `<option>${esc(m)}</option>`).join('');
    if (state.ai.provider === id && p.models.includes(state.ai.model)) $('aiModel').value = state.ai.model;
    $('aiKeyWrap').hidden = !(p.needsKey || custom);
    $('aiKeyLink').hidden = !p.keyUrl; if (p.keyUrl) $('aiKeyLink').href = p.keyUrl;
    $('aiKey').value = state.ai.provider === id ? state.ai.apiKey || '' : '';
    if (custom) { $('aiUrl').value = state.ai.provider === 'custom' ? state.ai.baseUrl || '' : ''; $('aiModelCustom').value = state.ai.provider === 'custom' ? state.ai.model || '' : ''; }
  }
  $('aiBtn').onclick = () => {
    if (!state.providers.length) return;
    $('aiProvider').innerHTML = state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $('aiProvider').value = preset().id; fillAiDialog(); $('aiDlg').showModal();
  };
  $('aiProvider').onchange = fillAiDialog;
  $('aiDlg').addEventListener('close', () => {
    if ($('aiDlg').returnValue !== 'save') return;
    const id = $('aiProvider').value; const custom = id === 'custom';
    state.ai = { provider: id, model: custom ? $('aiModelCustom').value.trim() : $('aiModel').value, baseUrl: custom ? $('aiUrl').value.trim() : '', apiKey: $('aiKey').value.trim() };
    store.set('ict.ai', JSON.stringify(state.ai)); drawAiLine();
  });
  fetch('/api/providers').then((r) => r.json()).then((p) => { state.providers = p; drawAiLine(); }).catch(() => {});

  // optional deep link: /?symbol=MGC&source=demo runs straight away
  const q = new URLSearchParams(location.search);
  if (q.get('symbol') && SYMBOLS.some(([k]) => k === q.get('symbol').toUpperCase())) { state.symbol = q.get('symbol').toUpperCase(); drawSymbols(); }
  if (['live', 'demo'].includes(q.get('source'))) { $('source').value = q.get('source'); syncSource(); }
  if (q.get('symbol') || q.get('source')) run();
}());
