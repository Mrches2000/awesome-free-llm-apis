'use strict';

// tick = minimum price step, pointValue = USD per 1.00 of price movement per contract.
const INSTRUMENTS = {
  MNQ: {
    key: 'MNQ', name: 'Micro E-mini Nasdaq-100', group: 'nasdaq', yahoo: 'MNQ=F', smt: 'ES=F', smtName: 'E-mini S&P 500 (ES)',
    tick: 0.25, pointValue: 2, decimals: 2, unit: 'pts', demoPrice: 25000, demoVol: 0.00028,
  },
  NQ: {
    key: 'NQ', name: 'E-mini Nasdaq-100', group: 'nasdaq', yahoo: 'NQ=F', smt: 'ES=F', smtName: 'E-mini S&P 500 (ES)',
    tick: 0.25, pointValue: 20, decimals: 2, unit: 'pts', demoPrice: 25000, demoVol: 0.00028,
  },
  MGC: {
    key: 'MGC', name: 'Micro Gold', group: 'gold', yahoo: 'MGC=F', smt: 'SI=F', smtName: 'Silver (SI)',
    tick: 0.1, pointValue: 10, decimals: 1, unit: '$', demoPrice: 4000, demoVol: 0.00019,
  },
  GC: {
    key: 'GC', name: 'Gold futures', group: 'gold', yahoo: 'GC=F', smt: 'SI=F', smtName: 'Silver (SI)',
    tick: 0.1, pointValue: 100, decimals: 1, unit: '$', demoPrice: 4000, demoVol: 0.00019,
  },
};

const roundTick = (inst, p) => Number((Math.round(p / inst.tick) * inst.tick).toFixed(inst.decimals));

module.exports = { INSTRUMENTS, roundTick };
