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

test('the ladder moves price from the base and reports P&L and return at each step', () => {
  const rows = calc.pnlLadder({ side: 'Short', entry: 100, qty: 2, margin: 20, base: 100, steps: [-5, 5] });
  assert.deepEqual(rows.map(r => [r.movePct, r.price, r.pnl, r.roiPct]), [[-5, 95, 10, 50], [5, 105, -10, -50]]);
});

test('size from risk loses exactly the risk at the stop, and refuses a stop on the wrong side', () => {
  const r = calc.sizeFromRisk({ side: 'Long', equity: 10000, riskPct: 1, entry: 100, stop: 95, lev: 5 });
  close(r.qty, 20);
  close(r.margin, 400);
  close(r.stopPct, 5);
  const loss = calc.pnlAt({ side: 'Long', entry: 100, qty: r.qty, exit: 95 }).pnl;
  close(-loss, r.riskUsd);
  close(calc.sizeFromRisk({ side: 'Short', equity: 10000, riskPct: 1, entry: 100, stop: 104 }).qty, 25);
  assert.deepEqual(calc.sizeFromRisk({ side: 'Long', equity: 10000, riskPct: 1, entry: 100, stop: 101 }), { wrongSide: true });
});

test('break-even pays back both fees and the funding held, long and short', () => {
  const args = { entry: 100, qty: 1, feeIn: 0.0005, feeOut: 0.0005, fundingRatePct: 0.01, intervalHours: 8, hours: 24 };
  for (const side of ['Long', 'Short']) {
    const r = calc.breakEven({ side, ...args });
    const { pnl } = calc.pnlAt({ side, entry: 100, qty: 1, exit: r.exit });
    close(pnl - r.fees - r.funding, 0);
  }
  close(calc.breakEven({ side: 'Long', ...args }).funding, 0.03);
  close(calc.breakEven({ side: 'Short', ...args }).funding, -0.03, 1e-12);
  const free = calc.breakEven({ side: 'Long', ...args, feeIn: 0, feeOut: 0, fundingRatePct: 0 });
  close(free.exit, 100);
});
