'use strict';

// tick = minimum price step, pointValue = USD per 1.00 of price movement per contract.
const INSTRUMENTS = {
  MNQ: {
    key: 'MNQ', tv: 'MNQ1!', name: 'Micro E-mini Nasdaq-100', group: 'nasdaq', yahoo: 'MNQ=F', smt: 'ES=F', smtName: 'E-mini S&P 500 (ES)',
    tick: 0.25, pointValue: 2, decimals: 2, unit: 'pts', demoPrice: 25000, demoVol: 0.00028,
  },
  NQ: {
    key: 'NQ', tv: 'NQ1!', name: 'E-mini Nasdaq-100', group: 'nasdaq', yahoo: 'NQ=F', smt: 'ES=F', smtName: 'E-mini S&P 500 (ES)',
    tick: 0.25, pointValue: 20, decimals: 2, unit: 'pts', demoPrice: 25000, demoVol: 0.00028,
  },
  MGC: {
    key: 'MGC', tv: 'MGC1!', name: 'Micro Gold', group: 'gold', yahoo: 'MGC=F', smt: 'SI=F', smtName: 'Silver (SI)',
    tick: 0.1, pointValue: 10, decimals: 1, unit: '$', demoPrice: 4000, demoVol: 0.00019,
    round: { step: 50, major: 100 }, // gold respects the $50 and $100 figures
  },
  GC: {
    key: 'GC', tv: 'GC1!', name: 'Gold futures', group: 'gold', yahoo: 'GC=F', smt: 'SI=F', smtName: 'Silver (SI)',
    tick: 0.1, pointValue: 100, decimals: 1, unit: '$', demoPrice: 4000, demoVol: 0.00019,
    round: { step: 50, major: 100 },
  },
};

/** Value of one tick for one contract (MGC: $1, GC: $10, MNQ: $0.50, NQ: $5). */
const tickValue = (inst) => Math.round(inst.tick * inst.pointValue * 100) / 100;

/**
 * Which market a chart title belongs to ("MGC1!", "Micro Gold Futures", "XAUUSD", "MNQ1!", "US100").
 * Returns an instrument key, or null when it cannot tell.
 */
function detectMarket(text) {
  const t = String(text || '').toUpperCase();
  if (!t) return null;
  if (/\bMGC/.test(t) || /MICRO\s+GOLD/.test(t)) return 'MGC';
  if (/\bGC[0-9!]|\bGC\b|\bXAU|GOLD/.test(t)) return 'GC';
  if (/\bMNQ/.test(t) || /MICRO\s+E-?MINI\s+NASDAQ/.test(t)) return 'MNQ';
  if (/\bNQ[0-9!]|\bNQ\b|NASDAQ|\bUS100|\bNAS100|\bUSTEC/.test(t)) return 'NQ';
  return null;
}

const roundTick = (inst, p) => Number((Math.round(p / inst.tick) * inst.tick).toFixed(inst.decimals));

module.exports = { INSTRUMENTS, roundTick, tickValue, detectMarket };
