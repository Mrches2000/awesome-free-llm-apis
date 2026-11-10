#!/usr/bin/env node
'use strict';
// ICT Analyzer — zero-dependency web server.  Start: node server.js  → http://localhost:4747

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { INSTRUMENTS } = require('./lib/instruments');
const { loadLive, loadCsv, loadDemo } = require('./lib/data');
const { getNews } = require('./lib/news');
const { analyze } = require('./lib/analyze');
const { analyzeImages, PROVIDERS } = require('./lib/vision');

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Upload too large (40 MB max).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function runAnalysis({ symbol, source, csv, withNews }) {
  const inst = INSTRUMENTS[String(symbol || '').toUpperCase()];
  if (!inst) throw new Error(`Unknown instrument "${symbol}". Use one of: ${Object.keys(INSTRUMENTS).join(', ')}.`);
  let data;
  if (source === 'csv') data = loadCsv(csv || '');
  else if (source === 'demo') data = loadDemo(inst);
  else data = await loadLive(inst);
  let news = null;
  if (withNews) {
    try { news = await getNews(inst.group); } catch (err) { news = null; }
  }
  const clock = data.source === 'live' ? Math.floor(Date.now() / 1000) : undefined;
  const result = analyze({ inst, tf: data.tf, smt: data.smt, news, source: data.source, clock });
  result.meta.note = data.note;
  result.meta.ageMin = data.source === 'demo' ? 0 : Math.max(0, Math.round((Date.now() / 1000 - result.meta.asOf) / 60));
  return result;
}

/** Screenshot mode: an AI reads the picture; price data (when it matches) does the exact maths. */
async function runImageAnalysis({ symbol, images, notes, llm, useFeed }) {
  const inst = INSTRUMENTS[String(symbol || '').toUpperCase()];
  if (!inst) throw new Error(`Unknown instrument "${symbol}". Use one of: ${Object.keys(INSTRUMENTS).join(', ')}.`);
  const preset = PROVIDERS[0];
  const cfg = {
    baseUrl: (llm && llm.baseUrl) || process.env.LLM_BASE_URL || preset.baseUrl,
    model: (llm && llm.model) || process.env.LLM_MODEL || preset.models[0],
    apiKey: (llm && llm.apiKey) || (llm && llm.baseUrl ? '' : process.env.LLM_API_KEY) || '',
  };
  let news = null;
  try { news = await getNews(inst.group); } catch { news = null; }
  const clock = Math.floor(Date.now() / 1000);
  let data = null; let engineResult = null;
  if (useFeed !== false) {
    try {
      data = await loadLive(inst);
      engineResult = analyze({ inst, tf: data.tf, smt: data.smt, news, source: 'live', clock });
    } catch { data = null; engineResult = null; } // the picture alone is still analysed
  }
  const rerun = data ? async (extra) => analyze({ inst, tf: data.tf, smt: data.smt, news, source: 'live', clock, ...extra }) : null;
  return analyzeImages({ inst, images, notes, llm: cfg, news, engineResult, rerun, now: clock });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/instruments') return send(res, 200, Object.values(INSTRUMENTS).map(({ key, name, tick, pointValue }) => ({ key, name, tick, pointValue })));
    if (url.pathname === '/api/providers') return send(res, 200, PROVIDERS);
    if (url.pathname === '/api/analyze-image') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      try { return send(res, 200, await runImageAnalysis(JSON.parse(await readBody(req)))); }
      catch (err) { return send(res, 422, { error: err.message }); }
    }
    if (url.pathname === '/api/analyze') {
      let params = { symbol: url.searchParams.get('symbol'), source: url.searchParams.get('source') || 'live', withNews: url.searchParams.get('news') !== '0' };
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        params = { symbol: body.symbol, source: 'csv', csv: body.csv, withNews: body.news !== false };
      }
      try { return send(res, 200, await runAnalysis(params)); }
      catch (err) { return send(res, 422, { error: err.message }); }
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`ICT Analyzer running → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}

module.exports = { server, runAnalysis, runImageAnalysis };
