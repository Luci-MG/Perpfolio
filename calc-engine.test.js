import test from 'node:test';
import assert from 'node:assert/strict';
import * as calc from './calc-engine.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('size from margin or quantity', () => {
  assert.deepEqual(calc.sizeFrom({ mode: 'usd', value: 100, entry: 50, lev: 10 }), { qty: 20, notional: 1000, margin: 100 });
  assert.deepEqual(calc.sizeFrom({ mode: 'qty', value: 20, entry: 50, lev: 10 }), { qty: 20, notional: 1000, margin: 100 });
  assert.equal(calc.sizeFrom({ mode: 'usd', value: 0, entry: 50, lev: 10 }), null);
});

test('P&L and the exit for a target return mirror each other, long and short', () => {
  for (const side of ['Long', 'Short']) {
    const exit = calc.exitForReturn({ side, entry: 100, qty: 2, margin: 20, targetPct: 50 });
    const { pnl, roiPct } = calc.pnlAt({ side, entry: 100, qty: 2, exit, margin: 20 });
    close(pnl, 10);
    close(roiPct, 50);
    assert.equal(exit, side === 'Long' ? 105 : 95);
  }
});

test('the averaging add reaches the target, and says when no add can', () => {
  const r = calc.averageAdd({ entry: 100, qtyOld: 1, newEntry: 80, target: 90 });
  close(r.addQty, 1);
  close(r.achieved, 90);
  assert.equal(calc.averageAdd({ entry: 100, qtyOld: 1, newEntry: 80, target: 110 }).unreachable, true);
  assert.equal(calc.averageAdd({ entry: 100, qtyOld: 1, newEntry: 80, target: 80 }).unreachable, true);
});

test('the isolated estimate moves entry by 1/leverage less the maintenance rate', () => {
  close(calc.isolatedLiq({ side: 'Long', entry: 100, lev: 10, mmrPct: 0.5 }).price, 90.5);
  close(calc.isolatedLiq({ side: 'Short', entry: 100, lev: 10, mmrPct: 0.5 }).price, 109.5);
  assert.equal(calc.isolatedLiq({ side: 'Long', entry: 100, lev: 0.5, mmrPct: 0.5 }).price, 0);
});

test('the maintenance rate follows the bracket for the notional', () => {
  const brackets = [{ notionalFloor: 0, notionalCap: 50000, maintMarginRatio: 0.004, cum: 0 },
                    { notionalFloor: 50000, notionalCap: 250000, maintMarginRatio: 0.005, cum: 50 }];
  assert.equal(calc.maintRatePct(brackets, 10000), 0.4);
  assert.equal(calc.maintRatePct(brackets, 60000), 0.5);
});
