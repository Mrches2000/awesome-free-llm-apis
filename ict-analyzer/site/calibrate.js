/*
 * Finds where the price labels sit on a chart screenshot, so a price can be turned
 * into a position on the picture.
 *
 * The AI reads the NUMBERS on the price axis (it does that well, but it cannot say
 * where they are). This code finds the label rows by scanning the pixels of the axis
 * strip at the right edge, and uses the highlighted last-price tag to decide which
 * label is which. Everything is a fraction of the picture: y = intercept + slope * price.
 */
(function () {
  'use strict';

  const dist = (r, g, b, c) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  /** Rows of text and solid tags inside the strip x0..W. Returns bands with their centre row. */
  function stripBands(data, W, H, x0) {
    const sw = W - x0;
    if (sw < 8) return { labels: [], tags: [] };
    // Background of the strip: the most common colour.
    const hist = new Map();
    for (let y = 0; y < H; y += 2) {
      for (let x = x0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        hist.set(k, (hist.get(k) || 0) + 1);
      }
    }
    let bk = 0; let bc = -1;
    for (const [k, c] of hist) if (c > bc) { bc = c; bk = k; }
    const bg = [((bk >> 10) & 31) * 8 + 4, ((bk >> 5) & 31) * 8 + 4, (bk & 31) * 8 + 4];
    // Share of non-background pixels per row.
    const ink = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = x0; x < W; x++) { const i = (y * W + x) * 4; if (dist(data[i], data[i + 1], data[i + 2], bg) > 100) n++; }
      ink[y] = n / sw;
    }
    // Solid tags first: rows that are mostly filled, split wherever the fill colour changes.
    const minTag = Math.max(6, 0.008 * H); const maxTag = Math.max(40, 0.05 * H);
    const maxLabel = Math.max(40, 0.035 * H); const minLabel = Math.max(4, 0.004 * H);
    const solid = new Uint8Array(H);
    for (let y = 0; y < H; y++) solid[y] = ink[y] >= 0.6 ? 1 : 0;
    // Dominant colour of a row in the strip: the fill of a tag, not its text.
    const leftColour = (y) => {
      const h = new Map();
      for (let x = x0; x < W; x += 1) { const i = (y * W + x) * 4; const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4); h.set(k, (h.get(k) || 0) + 1); }
      let bk = 0; let bc = -1; for (const [k, c] of h) if (c > bc) { bc = c; bk = k; }
      return [((bk >> 8) & 15) * 16 + 8, ((bk >> 4) & 15) * 16 + 8, (bk & 15) * 16 + 8];
    };
    const tags = [];
    for (let y = 0; y < H;) {
      if (!solid[y]) { y++; continue; }
      let e = y; let col = leftColour(y);
      while (e + 1 < H && solid[e + 1] && dist(...leftColour(e + 1), col) < 70) e++;
      const h = e - y + 1;
      if (h >= minTag && h <= maxTag) tags.push({ cy: (y + e) / 2, h });
      y = e + 1;
    }
    // Text rows: neighbouring rows with ink that are not part of a tag.
    const bands = [];
    let start = -1; let gap = 0;
    for (let y = 0; y <= H; y++) {
      const on = y < H && !solid[y] && ink[y] * sw >= 2;
      if (on) { if (start < 0) start = y; gap = 0; }
      else if (start >= 0) {
        gap++;
        if (gap > 1 || y === H) { bands.push({ y0: start, y1: y - gap }); start = -1; gap = 0; }
      }
    }
    const labels = [];
    for (const bd of bands) {
      const h = bd.y1 - bd.y0 + 1;
      if (h >= minLabel && h <= maxLabel) labels.push({ cy: (bd.y0 + bd.y1) / 2, h });
    }
    return { labels, tags };
  }

  /** The longest run of evenly spaced rows (the main price axis), gaps allowed. */
  function bestChain(rows) {
    let best = null;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const d = rows[j] - rows[i];
        if (d < 8) continue;
        const members = [{ cy: rows[i], idx: 0 }, { cy: rows[j], idx: 1 }];
        let idx = 1; let cur = rows[j]; let k = j + 1;
        while (k < rows.length) {
          const step = Math.round((rows[k] - cur) / d);
          if (step >= 1 && step <= 3 && Math.abs(rows[k] - cur - step * d) <= 0.14 * d) { idx += step; members.push({ cy: rows[k], idx }); cur = rows[k]; }
          k++;
        }
        if (!best || members.length > best.members.length) best = { members, d: d };
      }
    }
    return best;
  }

  /**
   * img: an HTMLImageElement or ImageBitmap. labels: the axis numbers the AI read, top to bottom.
   * hint: { plotRight, lastPrice }. Returns { ok, slope, intercept, plotRight, note }.
   */
  function calibrateAxis(img, labelsIn, hint) {
    const fail = (note) => ({ ok: false, slope: 0, intercept: 0, plotRight: (hint && hint.plotRight) || 0.92, note });
    const L = (labelsIn || []).filter((x) => Number.isFinite(x));
    if (L.length < 3) return fail('The AI did not read enough price labels to place marks.');
    // Price step between labels (they are evenly spaced), top to bottom.
    const diffs = []; for (let i = 0; i + 1 < L.length; i++) diffs.push(L[i] - L[i + 1]);
    const s = median(diffs);
    if (!(s > 0)) return fail('The price labels were not in order, so marks cannot be placed.');
    const regular = diffs.filter((d) => Math.abs(d - s) <= 0.02 * s).length;
    if (regular < Math.max(2, Math.floor(diffs.length * 0.6))) return fail('The price labels were not evenly spaced, so marks cannot be placed.');

    const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
    const W = Math.round(img.width * scale); const H = Math.round(img.height * scale);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;

    // Try the AI's guess for where the axis starts, then nearby positions; keep the best chain.
    const pr = (hint && hint.plotRight) || 0.92;
    let found = null;
    for (const off of [0, -0.01, 0.01, -0.02, 0.02, -0.03, 0.03, -0.05, 0.04, 0.06, -0.07]) {
      const x0 = Math.floor((pr + off + 0.004) * W);
      if (x0 < W * 0.5 || x0 > W - 12) continue;
      const bands = stripBands(data, W, H, x0);
      const chain = bestChain(bands.labels.map((b) => b.cy));
      if (!chain || chain.members.length < 3) continue;
      // prefer the chain whose length matches what the AI listed
      const score = chain.members.length - Math.abs(chain.members.length - L.length) * 0.5;
      if (!found || score > found.score) found = { score, x0, chain, tags: bands.tags };
      if (chain.members.length >= L.length) break;
    }
    if (!found) return fail('The price axis could not be found on the picture, so marks cannot be placed.');

    const { chain, tags } = found;
    const pxPerPrice = chain.d / s; // pixels per unit of price
    const lastPrice = hint && Number.isFinite(hint.lastPrice) ? hint.lastPrice : null;
    const listed = [...new Set(((hint && hint.tagPrices) || []).concat(lastPrice !== null ? [lastPrice] : []).filter(Number.isFinite))];
    const tol = Math.max(3.5, 0.005 * H);
    // Which listed label does the top row of the chain belong to? For each possible alignment,
    // every highlighted tag the AI listed must sit exactly where its price says. Accept only
    // when exactly one alignment fits.
    const fits = [];
    if (listed.length && tags.length) {
      for (const k of [0, -1, 1, -2, 2, -3, 3]) {
        const pTop = L[0] - k * s;
        const yAt = (price) => chain.members[0].cy + (pTop - price) * pxPerPrice;
        const free = tags.map((t) => t.cy); let ok = true; const used = [];
        for (const pr of listed) {
          let bi = -1; let be = Infinity;
          free.forEach((cy, i) => { const e = Math.abs(cy - yAt(pr)); if (e < be && !used.includes(i)) { be = e; bi = i; } });
          if (bi < 0 || be > tol) { ok = false; break; }
          used.push(bi);
        }
        if (ok) fits.push({ k, pTop });
      }
    }
    let pick; let anchored = false;
    if (fits.length === 1) { pick = fits[0]; anchored = true; }
    else if (fits.length > 1) {
      // Several alignments fit (tags of the same spacing). Trust the AI's list only when it matches the rows found.
      const zero = fits.find((f) => f.k === 0);
      if (zero && chain.members.length === L.length) { pick = zero; anchored = true; } else return fail('Two price tags look alike, so marks cannot be placed safely.');
    } else if (tags.length && listed.length) return fail('The newest price does not match the price axis, so marks cannot be placed.');
    else {
      // No tag to prove the alignment: accept it only when the AI listed exactly the rows found.
      if (!(chain.members.length === L.length)) return fail('Could not tell which price label is which, so marks cannot be placed.');
      pick = { k: 0, pTop: L[0] };
    }
    // Least-squares line through every labelled row and every matched tag.
    const pts = chain.members.map((m) => ({ price: pick.pTop - m.idx * s, y: m.cy }));
    if (anchored) {
      const yPred = (price) => chain.members[0].cy + (pick.pTop - price) * pxPerPrice;
      for (const pr of listed) {
        const t = tags.reduce((x, y) => (Math.abs(y.cy - yPred(pr)) < Math.abs(x.cy - yPred(pr)) ? y : x));
        if (Math.abs(t.cy - yPred(pr)) <= tol) pts.push({ price: pr, y: t.cy });
      }
    }
    const n = pts.length; const mp = pts.reduce((a, p) => a + p.price, 0) / n; const my = pts.reduce((a, p) => a + p.y, 0) / n;
    const vp = pts.reduce((a, p) => a + (p.price - mp) ** 2, 0);
    const b = pts.reduce((a, p) => a + (p.price - mp) * (p.y - my), 0) / vp; // px per price (negative)
    const a0 = my - b * mp;
    const resid = Math.max(...pts.map((p) => Math.abs(p.y - (a0 + b * p.price))));
    if (!(b < 0) || resid > Math.max(4, 0.006 * H)) return fail('The price labels did not line up, so marks cannot be placed.');
    return { ok: true, slope: b / H, intercept: a0 / H, plotRight: found.x0 / W, anchored, residualPx: Math.round(resid * 10) / 10, note: anchored ? '' : 'Marks are approximate: the last-price tag was not found.' };
  }

  window.calibrateAxis = calibrateAxis;
}());
