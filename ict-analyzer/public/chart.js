/* Canvas candlestick chart with ICT overlays. No dependencies. */
(function () {
  'use strict';
  const C = {
    bg: '#0e1219', grid: '#1b2130', text: '#8b94a7', bull: '#26a69a', bear: '#ef5350', amber: '#f0b429',
    blue: '#5b9cf5', violet: '#a78bfa', white: '#e6e9ef',
  };
  const AXIS_W = 74;
  const AXIS_H = 22;
  const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const nyParts = (t) => {
    const p = {};
    for (const x of nyFmt.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
    const h = Number(p.hour) % 24;
    return { h, mi: Number(p.minute), mins: h * 60 + Number(p.minute), md: `${p.month}/${p.day}`, wd: p.weekday };
  };
  const KZ = [
    { name: 'Asia', a: 1200, b: 1440, color: 'rgba(91,156,245,0.07)' },
    { name: 'London', a: 120, b: 300, color: 'rgba(167,139,250,0.10)' },
    { name: 'NY AM', a: 510, b: 660, color: 'rgba(240,180,41,0.09)' },
    { name: 'NY PM', a: 810, b: 960, color: 'rgba(38,166,154,0.08)' },
  ];

  class IctChart {
    constructor(canvas, tip) {
      this.cv = canvas; this.tip = tip; this.ctx = canvas.getContext('2d');
      this.layers = { fvg: true, ob: true, liq: true, structure: true, sessions: true, plan: true };
      this.d = null; this.g = null; this.mouse = null; this.drag = null;
      this.start = 0; this.count = 120;
      new ResizeObserver(() => this.draw()).observe(canvas);
      canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, start: this.start }; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => this.onMove(e));
      canvas.addEventListener('pointerup', () => { this.drag = null; });
      canvas.addEventListener('pointerleave', () => { this.mouse = null; this.tip.hidden = true; this.draw(); });
      canvas.addEventListener('dblclick', () => { this.reset(); this.draw(); });
    }

    setData(tfData, global) {
      this.d = tfData; this.g = global;
      this.ny = tfData.candles.map((c) => nyParts(c.t));
      this.reset(); this.draw();
    }

    reset() {
      const n = this.d.candles.length;
      this.count = Math.min(n + 14, 150);
      this.start = n + 14 - this.count;
    }

    fmt(p) { return Number(p).toLocaleString('en-US', { minimumFractionDigits: this.g.decimals, maximumFractionDigits: this.g.decimals }); }

    /** fractional candle index for a timestamp (clamped to the series) */
    idx(t) {
      const c = this.d.candles;
      if (t <= c[0].t) return 0;
      let lo = 0; let hi = c.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m].t <= t) lo = m; else hi = m - 1; }
      return lo;
    }

    onWheel(e) {
      e.preventDefault();
      if (!this.d) return;
      const r = this.cv.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width - AXIS_W)));
      const anchor = this.start + frac * this.count;
      const n = this.d.candles.length;
      this.count = Math.min(n + 30, Math.max(20, this.count * (e.deltaY > 0 ? 1.15 : 0.87)));
      this.start = anchor - frac * this.count;
      this.clamp(); this.draw();
    }

    onMove(e) {
      const r = this.cv.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.drag && this.d) {
        const barW = (r.width - AXIS_W) / this.count;
        this.start = this.drag.start - (e.clientX - this.drag.x) / barW;
        this.clamp();
      }
      this.draw();
    }

    clamp() {
      const n = this.d.candles.length;
      this.start = Math.min(n - 5, Math.max(-this.count + 10, this.start));
    }

    draw() {
      const cv = this.cv; const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth; const H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
      if (!this.d) return;
      const c = this.d.candles; const g = this.g; const L = this.layers;
      const pw = W - AXIS_W; const ph = H - AXIS_H; const top = 10;
      const barW = pw / this.count;
      const i0 = Math.max(0, Math.floor(this.start)); const i1 = Math.min(c.length - 1, Math.ceil(this.start + this.count));
      const X = (i) => (i - this.start + 0.5) * barW;
      const plan = L.plan && g.plan && g.plan.entry !== undefined ? g.plan : null;

      // price scale from visible candles (+ the trade plan when it is close by)
      let lo = Infinity; let hi = -Infinity;
      for (let i = i0; i <= i1; i++) { if (c[i].l < lo) lo = c[i].l; if (c[i].h > hi) hi = c[i].h; }
      if (!Number.isFinite(lo)) { lo = c[c.length - 1].l; hi = c[c.length - 1].h; }
      if (plan) {
        const span = hi - lo || 1;
        for (const p of [plan.entry, plan.stop, ...plan.targets.map((t) => t.price)]) {
          if (p > lo - 1.5 * span && p < hi + 1.5 * span) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
        }
      }
      const pad = (hi - lo) * 0.07 || 1; lo -= pad; hi += pad;
      const Y = (p) => top + (hi - p) / (hi - lo) * (ph - top);
      const inY = (p) => p >= lo && p <= hi;

      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();

      // killzone shading
      const intraday = c.length > 1 && c[1].t - c[0].t <= 3600;
      if (L.sessions && intraday) {
        ctx.font = '10px system-ui'; ctx.textBaseline = 'top';
        for (const k of KZ) {
          let s = -1;
          for (let i = i0; i <= i1 + 1; i++) {
            const inK = i <= i1 && this.ny[i].mins >= k.a && this.ny[i].mins < k.b;
            if (inK && s < 0) s = i;
            if (!inK && s >= 0) {
              ctx.fillStyle = k.color; ctx.fillRect(X(s) - barW / 2, 0, (i - s) * barW, ph);
              if ((i - s) * barW > 34) { ctx.fillStyle = 'rgba(139,148,167,0.75)'; ctx.fillText(k.name, X(s) - barW / 2 + 4, 3); }
              s = -1;
            }
          }
        }
      }

      // grid + price labels prepared
      const step = niceStep((hi - lo) / 7);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      for (let p = Math.ceil(lo / step) * step; p < hi; p += step) { const y = Math.round(Y(p)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke(); }

      const zone = (z, fill, stroke, label, dashed) => {
        const x0 = Math.max(X(this.idx(z.t)) - barW / 2, -2);
        const y0 = Y(z.top); const y1 = Y(z.bot);
        if (y1 < 0 || y0 > ph) return;
        ctx.fillStyle = fill; ctx.fillRect(x0, y0, pw - x0, Math.max(1, y1 - y0));
        ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.setLineDash(dashed ? [4, 3] : []);
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - x0, Math.max(1, y1 - y0)); ctx.setLineDash([]);
        if (y1 - y0 > 9 && x0 < pw - 40) { ctx.fillStyle = stroke; ctx.font = '10px system-ui'; ctx.textBaseline = 'middle'; ctx.fillText(label, Math.max(x0 + 4, 4), (y0 + y1) / 2); }
      };
      if (L.fvg) {
        for (const f of this.d.fvgs) {
          const bull = f.dir === 1;
          zone(f, bull ? `rgba(38,166,154,${f.tapped ? 0.10 : 0.2})` : `rgba(239,83,80,${f.tapped ? 0.09 : 0.18})`, bull ? C.bull : C.bear, f.kind, f.kind === 'IFVG');
          if (f.kind === 'FVG' && !f.tapped) { const y = Math.round(Y(f.ce)) + 0.5; ctx.strokeStyle = bull ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(Math.max(X(this.idx(f.t)), 0), y); ctx.lineTo(pw, y); ctx.stroke(); ctx.setLineDash([]); }
        }
        for (const b of this.d.bprs) zone(b, 'rgba(240,180,41,0.10)', C.amber, 'BPR', true);
      }
      if (L.ob) for (const b of this.d.obs) zone(b, b.dir === 1 ? 'rgba(91,156,245,0.16)' : 'rgba(240,140,60,0.15)', b.dir === 1 ? C.blue : '#f08c3c', `${b.dir === 1 ? '+' : '−'}${b.kind}`, b.kind === 'Breaker');

      // structure
      if (L.structure) {
        ctx.font = '10px system-ui'; ctx.textBaseline = 'bottom';
        for (const e of this.d.events) {
          const xa = X(this.idx(e.swingT)); const xb = X(this.idx(e.t)); const y = Math.round(Y(e.level)) + 0.5;
          if (xb < 0 || xa > pw || !inY(e.level)) continue;
          const col = e.dir === 1 ? C.bull : C.bear;
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(e.type === 'BOS' ? [] : [5, 3]);
          ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = col; ctx.textAlign = 'center';
          ctx.fillText(e.type, (xa + xb) / 2, e.dir === 1 ? y - 2 : y + 12);
        }
        ctx.textAlign = 'left';
      }

      // candles
      const bw = Math.max(1, Math.min(14, barW * 0.68));
      for (let i = i0; i <= i1; i++) {
        const k = c[i]; const up = k.c >= k.o; const x = X(i);
        ctx.strokeStyle = ctx.fillStyle = up ? C.bull : C.bear; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(k.h)); ctx.lineTo(Math.round(x) + 0.5, Y(k.l)); ctx.stroke();
        const y0 = Y(Math.max(k.o, k.c)); const y1 = Y(Math.min(k.o, k.c));
        ctx.fillRect(x - bw / 2, y0, bw, Math.max(1, y1 - y0));
      }

      // liquidity
      const tags = [];
      if (L.liq) {
        ctx.font = '10px system-ui'; ctx.textBaseline = 'bottom';
        const used = [];
        const pools = [...g.pools].sort((a, b) => b.strength - a.strength);
        for (const p of pools) {
          if (!inY(p.price)) continue;
          const y = Math.round(Y(p.price)) + 0.5;
          const taken = p.takenT !== null;
          const xa = Math.max(0, X(this.idx(p.t)));
          const xb = taken ? X(this.idx(p.takenT)) : pw;
          if (xb < 0) continue;
          ctx.strokeStyle = taken ? 'rgba(240,180,41,0.3)' : `rgba(240,180,41,${p.strength >= 3 ? 0.95 : 0.6})`;
          ctx.lineWidth = p.strength >= 3 && !taken ? 1.4 : 1; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]);
          if (taken) { ctx.fillStyle = 'rgba(240,180,41,0.7)'; ctx.textAlign = 'center'; ctx.fillText('✕', xb, y + 5); ctx.textAlign = 'left'; continue; }
          if (used.some((u) => Math.abs(u - y) < 12)) continue;
          used.push(y);
          const txt = `${p.side === 'BSL' ? '▲' : '▼'} ${p.label}`;
          ctx.fillStyle = 'rgba(240,180,41,0.95)'; ctx.textAlign = 'right'; ctx.fillText(txt, pw - 6, y - 2); ctx.textAlign = 'left';
          if (p.strength >= 3) tags.push({ y, text: this.fmt(p.price), bg: '#3b2f0b', fg: C.amber });
        }
        // opening prices
        const o = g.opens || {};
        for (const [key, name] of [['midnight', 'Midnight open'], ['o830', '08:30 open']]) {
          if (!o[key] || !inY(o[key].price) || !intraday) continue;
          const y = Math.round(Y(o[key].price)) + 0.5; const xa = Math.max(0, X(this.idx(o[key].t)));
          ctx.strokeStyle = 'rgba(230,233,239,0.45)'; ctx.setLineDash([1, 4]); ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(pw, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(230,233,239,0.6)'; ctx.fillText(name, xa + 4, y - 2);
        }
        // raid markers
        ctx.textAlign = 'center';
        for (const s of this.d.sweeps) {
          const i = this.idx(s.t); if (i < i0 || i > i1) continue;
          const k = c[i]; ctx.fillStyle = C.amber;
          ctx.fillText('raid', X(i), s.side === 'BSL' ? Y(k.h) - 4 : Y(k.l) + 14);
        }
        ctx.textAlign = 'left';
      }

      // trade plan
      if (plan) {
        const s = plan.setup; const live = plan.action !== 'WAIT';
        const x0 = Math.max(0, X(this.idx(s.zoneT)));
        const ye = Y(plan.entry); const ys = Y(plan.stop); const yt = Y(plan.targets[plan.targets.length - 1].price);
        ctx.globalAlpha = live ? 1 : 0.55;
        ctx.fillStyle = 'rgba(239,83,80,0.13)'; ctx.fillRect(x0, Math.min(ye, ys), pw - x0, Math.abs(ys - ye));
        ctx.fillStyle = 'rgba(38,166,154,0.11)'; ctx.fillRect(x0, Math.min(ye, yt), pw - x0, Math.abs(yt - ye));
        const line = (p, col, text, dash) => {
          const y = Math.round(Y(p)) + 0.5;
          ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.setLineDash(dash || []);
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(pw, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.font = '600 11px system-ui'; ctx.textBaseline = 'bottom'; ctx.fillStyle = col; ctx.fillText(text, x0 + 6, y - 3);
          tags.push({ y, text: this.fmt(p), bg: col, fg: '#0b0e13', strong: true });
        };
        line(plan.entry, C.white, `${live ? '' : '(reference) '}ENTRY ${plan.dir === 1 ? 'LONG' : 'SHORT'}`);
        line(plan.stop, C.bear, 'STOP');
        for (const t of plan.targets) line(t.price, C.bull, `TP ${t.rr}R${t.rr === plan.preferred ? ' ★' : ''}`, [5, 3]);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      // axes
      ctx.fillStyle = C.bg; ctx.fillRect(pw, 0, AXIS_W, H); ctx.fillRect(0, ph, W, AXIS_H);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(pw + 0.5, 0); ctx.lineTo(pw + 0.5, ph); ctx.moveTo(0, ph + 0.5); ctx.lineTo(W, ph + 0.5); ctx.stroke();
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.text;
      for (let p = Math.ceil(lo / step) * step; p < hi; p += step) ctx.fillText(this.fmt(p), pw + 6, Y(p));
      // time labels
      const every = Math.max(1, Math.ceil(84 / barW));
      ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      let lastDay = '';
      for (let i = i0; i <= i1; i++) {
        if (i % every) continue;
        const n = this.ny[i];
        const txt = intraday ? (n.md !== lastDay ? `${n.wd} ${n.md}` : `${String(n.h).padStart(2, '0')}:${String(n.mi).padStart(2, '0')}`) : n.md;
        lastDay = n.md;
        ctx.fillText(txt, X(i), ph + 5);
      }
      ctx.textAlign = 'left';
      // last price + tags
      const lastP = c[c.length - 1].c;
      tags.push({ y: Math.round(Y(lastP)) + 0.5, text: this.fmt(lastP), bg: c[c.length - 1].c >= c[c.length - 1].o ? C.bull : C.bear, fg: '#0b0e13', strong: true, price: true });
      if (inY(lastP)) { ctx.strokeStyle = 'rgba(230,233,239,0.25)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, tags[tags.length - 1].y); ctx.lineTo(pw, tags[tags.length - 1].y); ctx.stroke(); ctx.setLineDash([]); }
      ctx.textBaseline = 'middle';
      tags.sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0));
      const drawn = [];
      for (const t of tags) {
        if (t.y < 6 || t.y > ph - 4 || drawn.some((u) => Math.abs(u - t.y) < 15)) continue;
        drawn.push(t.y);
        ctx.fillStyle = t.bg; ctx.fillRect(pw + 1, t.y - 8, AXIS_W - 2, 16);
        ctx.fillStyle = t.fg; ctx.fillText(t.text, pw + 6, t.y);
      }

      // crosshair
      const m = this.mouse;
      if (m && m.x < pw && m.y < ph && !this.drag) {
        const i = Math.round(this.start + m.x / barW - 0.5);
        ctx.strokeStyle = 'rgba(230,233,239,0.35)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, m.y + 0.5); ctx.lineTo(pw, m.y + 0.5); ctx.moveTo(Math.round(X(i)) + 0.5, 0); ctx.lineTo(Math.round(X(i)) + 0.5, ph); ctx.stroke(); ctx.setLineDash([]);
        const price = hi - (m.y - top) / (ph - top) * (hi - lo);
        ctx.fillStyle = '#2a3348'; ctx.fillRect(pw + 1, m.y - 8, AXIS_W - 2, 16); ctx.fillStyle = C.white; ctx.fillText(this.fmt(price), pw + 6, m.y);
        if (i >= 0 && i < c.length) {
          const k = c[i]; const n = this.ny[i];
          this.tip.hidden = false;
          this.tip.textContent = `${n.wd} ${n.md} ${String(n.h).padStart(2, '0')}:${String(n.mi).padStart(2, '0')} NY   O ${this.fmt(k.o)}  H ${this.fmt(k.h)}  L ${this.fmt(k.l)}  C ${this.fmt(k.c)}`;
        }
      }
    }
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  window.IctChart = IctChart;
}());
