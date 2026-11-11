/*
 * Draws the ICT marks on top of the trader's own screenshot: gaps, order blocks,
 * liquidity, sweeps, and the trade (entry, stop, targets). Positions come from
 * r.annot: y = intercept + slope * price, as fractions of the picture, so it works
 * at any size.
 */
(function () {
  'use strict';
  const C = {
    bull: '#2ee6b8', bear: '#ff5d73', liq: '#ffc04d', plan: '#8da2ff', white: '#ffffff', ink: 'rgba(8,11,18,0.86)',
  };
  const FONT = '600 11px Inter, system-ui, sans-serif';

  /** Which marks to draw: engine zones when price data was added, else what the AI saw. */
  function collect(r) {
    const a = r.annot || {};
    const zones = []; const lines = []; const dots = [];
    const eng = r.chart && (r.chart[(r.plan && r.plan.tf)] || r.chart.M5 || r.chart.M15 || r.chart.H1);
    if (eng) {
      for (const g of eng.fvgs || []) zones.push({ kind: g.kind === 'IFVG' ? 'ifvg' : 'fvg', dir: g.dir, top: g.top, bottom: g.bot, label: g.kind });
      for (const b of eng.obs || []) zones.push({ kind: b.kind === 'Breaker' ? 'breaker' : 'ob', dir: b.dir, top: b.top, bottom: b.bot, label: b.kind === 'Breaker' ? 'BRK' : 'OB' });
    }
    for (const m of a.marks || []) {
      if (['fvg', 'ifvg', 'ob', 'breaker'].includes(m.kind)) { if (!eng) zones.push({ ...m, label: m.label || m.kind.toUpperCase() }); }
      else if (m.kind === 'liquidity') lines.push({ price: m.price, label: m.label || 'Liquidity', x: m.x, side: m.dir === 1 ? 'up' : null });
      else dots.push(m);
    }
    const pools = (r.liquidity && [...(r.liquidity.above || []), ...(r.liquidity.below || [])]) || (r.read && [...(r.read.above || []), ...(r.read.below || [])]) || [];
    for (const p of pools) if (!lines.some((l) => Math.abs(l.price - p.price) < 1e-9)) lines.push({ price: p.price, label: p.label, x: null });
    return { zones, lines, dots };
  }

  function draw(canvas, r, layers) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    if (!W || !H) return false;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const a = r.annot;
    if (!a || !a.ok) return false;
    const yOf = (price) => (a.intercept + a.slope * price) * H;
    const right = a.plotRight * W;
    const dec = r.meta.decimals;
    const fmt = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const tags = [];
    const L = layers || {};
    const { zones, lines, dots } = collect(r);
    const startOf = (x, fallback) => (x !== null && x !== undefined && x > 0.02 && x < a.plotRight - 0.1 ? x * W : fallback * right);
    const visible = (y) => y > -4 && y < H + 4;
    ctx.font = FONT; ctx.textBaseline = 'middle';

    const chip = (x, y, text, color, align) => {
      const w = ctx.measureText(text).width + 10; const h = 16;
      const x0 = align === 'right' ? x - w : x;
      ctx.fillStyle = C.ink; ctx.beginPath(); ctx.roundRect(x0, y - h / 2, w, h, 4); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x0 + 0.5, y - h / 2 + 0.5, w - 1, h - 1, 4); ctx.stroke();
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(text, x0 + 5, y + 0.5);
    };

    // zones (gaps and blocks)
    for (const z of zones) {
      const isGap = z.kind === 'fvg' || z.kind === 'ifvg';
      if (isGap ? !L.gaps : !L.blocks) continue;
      const y0 = yOf(z.top); const y1 = yOf(z.bottom);
      if (!visible(y0) && !visible(y1)) continue;
      const col = z.dir === -1 ? C.bear : C.bull;
      const x0 = startOf(z.x, 0.55);
      const top = Math.min(y0, y1); const h = Math.max(3, Math.abs(y1 - y0));
      ctx.globalAlpha = 0.2; ctx.fillStyle = col; ctx.fillRect(x0, top, right - x0, h);
      ctx.globalAlpha = 0.95; ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(isGap ? [] : [5, 3]);
      ctx.strokeRect(x0 + 0.5, top + 0.5, right - x0 - 1, h - 1); ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const name = z.kind === 'ob' ? 'OB' : z.kind === 'breaker' ? 'BRK' : z.kind === 'ifvg' ? 'IFVG' : 'FVG';
      chip(x0 + 3, Math.min(Math.max(top + h / 2, 10), H - 10), `${z.dir === -1 ? '▼' : '▲'} ${name}`, col, 'left');
    }
    // liquidity lines
    if (L.liq) {
      let n = 0;
      const sorted = [...lines].sort((p, q) => Math.abs(p.price - r.meta.price) - Math.abs(q.price - r.meta.price)).slice(0, 5);
      for (const ln of sorted) {
        const y = yOf(ln.price); if (!visible(y)) continue;
        const x0 = startOf(ln.x, 0.04);
        ctx.strokeStyle = C.liq; ctx.lineWidth = 1.3; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(right, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        const above = ln.price > r.meta.price;
        tags.push({ y, text: `${above ? '▲' : '▼'} ${shortLabel(ln.label)}`, color: C.liq });
        n++;
      }
      for (const d of dots) {
        if (d.kind !== 'sweep') continue;
        const y = yOf(d.price); const x = (d.x !== null && d.x !== undefined ? d.x : 0.7) * W;
        if (!visible(y) || x > right) continue;
        ctx.strokeStyle = C.liq; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fillStyle = C.liq; ctx.fill();
        chip(x + 13, y - 14, 'SWEPT', C.liq, 'left');
      }
    }
    if (L.struct !== false) {
      for (const d of dots) {
        if (d.kind !== 'shift') continue;
        const y = yOf(d.price); const x = (d.x !== null && d.x !== undefined ? d.x : 0.75) * W;
        if (!visible(y) || x > right) continue;
        const col = d.dir === -1 ? C.bear : C.bull;
        ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(Math.max(0, x - 40), y); ctx.lineTo(Math.min(right, x + 30), y); ctx.stroke(); ctx.setLineDash([]);
        chip(x, y - (d.dir === -1 ? -13 : 13), d.label || 'MSS', col, 'left');
      }
    }
    // the trade
    const p = r.plan;
    if (L.plan && p && p.entry !== undefined) {
      const live = p.action !== 'WAIT';
      const ye = yOf(p.entry); const ys = yOf(p.stop); const far = p.targets.length ? yOf(p.targets[p.targets.length - 1].price) : ye;
      const x0 = Math.max(0.12 * W, right - 0.42 * W);
      ctx.globalAlpha = live ? 1 : 0.6;
      ctx.fillStyle = 'rgba(255,93,115,0.16)'; ctx.fillRect(x0, Math.min(ye, ys), right - x0, Math.abs(ys - ye));
      ctx.fillStyle = 'rgba(46,230,184,0.14)'; ctx.fillRect(x0, Math.min(ye, far), right - x0, Math.abs(far - ye));
      const hline = (price, color, dash, width) => {
        const y = yOf(price); if (!visible(y)) return;
        ctx.strokeStyle = color; ctx.lineWidth = width || 1.5; ctx.setLineDash(dash || []);
        ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(right, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      };
      hline(p.entry, C.white, [], 2); hline(p.stop, C.bear, [], 1.6);
      for (const t of p.targets) hline(t.price, C.bull, [5, 3], 1.3);
      ctx.globalAlpha = 1;
      const pre = live ? '' : 'ref ';
      tags.push({ y: ye, text: `${pre}ENTRY ${fmt(p.entry)}`, color: C.white, strong: true });
      tags.push({ y: ys, text: `${pre}STOP ${fmt(p.stop)}`, color: C.bear, strong: true });
      for (const t of p.targets) tags.push({ y: yOf(t.price), text: `${t.rr}R${t.rr === p.preferred ? ' ★' : ''} ${fmt(t.price)}`, color: C.bull, strong: true });
    }
    // tags on the right, nudged apart so they never overlap; off-picture prices pin to the edge
    tags.sort((q, w) => q.y - w.y);
    let prev = -Infinity;
    for (const t of tags) {
      let y = Math.min(Math.max(t.y, 10), H - 10);
      if (y - prev < 17) y = prev + 17;
      prev = y;
      const off = t.y < 0 ? '▲ ' : t.y > H ? '▼ ' : '';
      chip(right - 4, y, off + t.text, t.color, 'right');
    }
    return true;
  }

  const shortLabel = (s) => String(s || '').replace(/\s*\+\s*.*/, '').replace(/swing /i, '').replace(/Previous /i, 'Prev ').replace(/Equal /i, 'EQ ').slice(0, 18);

  window.IctOverlay = { draw };
}());
