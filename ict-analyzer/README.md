# ICT Analyzer

A local web dashboard that reads gold and Nasdaq futures charts the ICT (Inner Circle Trader) way and tells you what it thinks the best move is: **long, short, or wait** — with an entry, a stop and targets at **1.5R, 2R and 2.5R**.

It is built for short-term trading of:

| Button | Market | Tick | $ per point |
| ------ | ------ | ---- | ----------- |
| `MNQ`  | Micro E-mini Nasdaq-100 | 0.25 | $2 |
| `MGC`  | Micro Gold | 0.10 | $10 |
| `NQ`   | E-mini Nasdaq-100 | 0.25 | $20 |
| `GC`   | Gold futures | 0.10 | $100 |

> **This is an analysis aid, not financial advice.** It applies rules mechanically. It has not been back-tested, the score is not a win probability, and futures are leveraged. Check every level on your own chart before you place an order.

## Start it

You need [Node.js](https://nodejs.org) 20 or newer. Nothing to install.

```bash
cd ict-analyzer
node server.js
```

Open <http://localhost:4747>, pick a market and press **Analyze**.

## Where the prices come from

| Data option | What it is | When to use it |
| ----------- | ---------- | -------------- |
| **Live** | Yahoo Finance futures candles. Free, no account. **Delayed about 10 minutes.** | Planning the session, bias, liquidity map. |
| **My CSV export** | A file you export from your own chart. Real-time accurate. | When you are about to take the trade. |
| **Demo** | Simulated prices. | Trying the tool. Never trade from it. |

**CSV from TradingView:** open the chart on the 1-minute or 5-minute timeframe, scroll back so plenty of history is loaded (20+ days is best), then *layout menu → Export chart data…*. Upload that file. The tool builds every higher timeframe from it. Columns needed: `time, open, high, low, close`.

Because the live feed is delayed, an entry that says "price is in the zone now" may already have moved. For execution, use a fresh CSV or confirm on your broker's chart.

## What it analyses

It reads six timeframes top-down — **Daily → H4 → H1 → M15 → M5 → M1** — in New York time.

| ICT concept | What the engine does |
| ----------- | -------------------- |
| Market structure | Swing highs/lows, break of structure (BOS), market structure shift (MSS, with displacement) and CHoCH (without) on every timeframe. |
| Daily bias | Daily/H4/H1 structure, the previous-day candle (close through or failed raid of the prior day's range), reaction from higher-timeframe PD arrays, weekly open. |
| Liquidity | Buy-side and sell-side pools: previous day and week high/low, Asia / London / NY AM / NY PM session highs and lows, H4/H1/M15 swing points, equal highs and equal lows, 20-day extremes. Tracks which are untouched and which were raided. |
| Liquidity sweep | A raid of a pool that closes back inside (stop hunt / turtle soup / Judas swing). |
| Displacement | Energetic candles and legs that leave a gap behind. |
| Fair value gaps | Detection, consequent encroachment (50%), tapped / filled state, **inversion (IFVG)**, and **balanced price ranges**. |
| Order blocks | Last opposite candle before the leg that broke structure, and **breaker blocks** when one fails. |
| Opening gaps | New day opening gap (NDOG) and new week opening gap (NWOG). |
| Premium / discount | H1 dealing range, equilibrium, **OTE 62–79%**, plus the IPDA 20 / 40 / 60-day ranges. |
| Time | Killzones (Asia, London, NY AM, NY PM), NY lunch no-trade zone, **Silver Bullet** hours, macro windows, midnight / 08:30 / 09:30 / daily / weekly opens. |
| Power of 3 (AMD) | Asian range as accumulation, which side was raided (manipulation), where price is delivering (distribution). |
| SMT divergence | Nasdaq against the S&P 500 (ES), gold against silver (SI). |
| Entry models | ICT 2022 model (raid → shift → FVG entry), Silver Bullet, Unicorn (breaker + FVG), change in state of delivery (CISD) as early warning. |

Not included: volume imbalances, mitigation and rejection blocks, standard-deviation projections, quarterly theory and weekly profiles.

## How it decides

Every candidate trade is scored out of 100. **ICT is 87.5 points, news is 12.5 points.**

| Check | Points |
| ----- | -----: |
| Higher-timeframe bias | 16 |
| Liquidity sweep | 12 |
| Structure shift + displacement | 12 |
| Entry PD array (FVG / order block / breaker) | 9 |
| Room to the draw on liquidity | 8 |
| Premium / discount | 8 |
| Killzone timing | 8 |
| OTE | 4 |
| SMT divergence | 4 |
| Opening price (Power of 3) | 3.5 |
| H1 order flow | 3 |
| **News: headline tone** | 7.5 |
| **News: economic calendar** | 5 |

It only says **LONG** or **SHORT** when all of these hold:

- the score is 65 or more (B ≥ 65, A ≥ 73, A+ ≥ 82);
- liquidity was raided, structure shifted, and there is an entry array;
- the trade does not go against a clear higher-timeframe bias;
- no high-impact USD release is due in the next 30 minutes;
- it is not NY lunch or the 16:00–18:00 close;
- the entry has not already filled and run away.

Otherwise it says **WAIT** and tells you exactly what has to happen first (which level must be raided, which level must be closed through). Waiting is the most common answer, on purpose.

The stop goes beyond the raid low/high (or beyond the swing protecting the entry array when the raid stop would be too wide). Targets are fixed at 1.5R, 2R and 2.5R; the ★ target is the furthest one that still has untouched liquidity behind it. The position-size box turns your dollar risk into a number of contracts.

## News and world events (12.5%)

- **Economic calendar** — this week's medium and high impact USD releases (ForexFactory feed).
- **Headlines** — the last 24 hours from Google News for gold or the Nasdaq, scored with a transparent keyword scan (rate cuts, dollar, yields, war, tariffs, sell-offs…).

If a feed is unreachable the news part is scored neutral and the page says so.

### Optional: let an AI read the headlines

The keyword scan is simple. You can replace it with any OpenAI-compatible model — the free APIs listed in [this repository's main README](../README.md) work. Set three variables before starting:

```bash
LLM_BASE_URL=https://api.groq.com/openai/v1 \
LLM_API_KEY=your_key \
LLM_MODEL=llama-3.3-70b-versatile \
node server.js
```

The model only judges headline tone. It never changes the ICT part of the score. This path has not been tested against a live provider; if the call fails the tool falls back to the keyword scan.

## Settings

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `4747` | Port of the web page. |
| `HOST` | `127.0.0.1` | Only your own computer can open it. |
| `ICT_USER_AGENT` | `Mozilla/5.0 (compatible; ict-analyzer/1.0)` | Identifier sent to the data feeds. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | – | Optional AI headline reading. |

## Tests

```bash
npm test
```

## Files

```
server.js          web server and API (/api/analyze)
lib/ict.js         detectors: swings, structure, FVG, order blocks, breakers, BPR, equal highs/lows
lib/analyze.js     bias, liquidity map, entry model, scoring, trade plan
lib/narrative.js   the written breakdown
lib/news.js        calendar, headlines, tone
lib/data.js        live feed, CSV import, demo data
lib/time.js        New York sessions, killzones, trading day
public/            the web page and chart
```

## Known limits

- Live prices are delayed and come from an unofficial Yahoo Finance endpoint that can rate-limit or change without notice. Use the CSV option when that happens.
- Swing detection is mechanical (fixed fractal width). A discretionary ICT trader will sometimes mark a different swing, order block or dealing range.
- The candle that is still forming is included, so a "close above" can un-happen until the bar finishes.
- Weights and thresholds are judgement calls, not fitted to historical results.
