// stats.js — the intervals every journal number is shown with: Wilson for a rate, Welch and a
// day-clustered bootstrap for an average, Benjamini–Hochberg across many comparisons. 90%
// throughout, seeded so the same history always gives the same answer. Method and sources:
// docs/research/outcome-factors.md. Pure.

const Z90 = 1.6448536;
export const BOOTSTRAP_DRAWS = 2000;
const SEED = 20261003;
const FDR_Q = 0.10;

/** mulberry32: a small seeded generator, so a resample is reproducible. */
export function seededRandom(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

function variance(xs) {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, error under 7.5e-8). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function tQuantileCornishFisher(z, df) {
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2);
}

/** Welch interval (90%) and two-sided p for mean(a) − mean(b); null when either side has under two values. */
export function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length, vb = variance(b) / b.length;
  const se = Math.sqrt(va + vb);
  const diff = mean(a) - mean(b);
  if (!se) return { lo: diff, hi: diff, p: diff ? 0 : 1 };
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const half = tQuantileCornishFisher(Z90, df) * se;
  const z = Math.abs(diff / se) * (1 - 1 / (4 * df)) / Math.sqrt(1 + (diff / se) ** 2 / (2 * df));
  return { lo: diff - half, hi: diff + half, p: 2 * (1 - normalCdf(z)) };
}

/** Wilson score interval (90%) for k wins in n. */
export function wilson(k, n) {
  if (!n) return null;
  const p = k / n, z2 = Z90 ** 2;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = Z90 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return { lo: centre - half, hi: centre + half };
}

/** Which of `pValues` pass Benjamini–Hochberg at false-discovery rate `q`. */
export function benjaminiHochberg(pValues, q = FDR_Q) {
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  let cutoff = -1;
  order.forEach(({ p }, rank) => { if (p <= (rank + 1) / order.length * q) cutoff = rank; });
  const pass = new Array(pValues.length).fill(false);
  for (let r = 0; r <= cutoff; r++) pass[order[r].i] = true;
  return pass;
}

/**
 * Interval (90%) and two-sided p against zero for `statistic`, resampling whole days so a
 * day's trips move together. `statistic` takes the trips of one resample and returns a
 * number, or null to skip that draw; null when every draw was skipped.
 */
export function dayBootstrap(days, statistic, draws = BOOTSTRAP_DRAWS) {
  if (!days.length) return null;
  const random = seededRandom();
  const values = [];
  for (let b = 0; b < draws; b++) {
    const sample = [];
    for (let d = 0; d < days.length; d++) sample.push(days[Math.floor(random() * days.length)]);
    const v = statistic(sample.flat());
    if (v != null) values.push(v);
  }
  if (!values.length) return null;
  values.sort((x, y) => x - y);
  const below = values.filter(x => x <= 0).length, above = values.length - below;
  return { lo: quantile(values, 0.05), hi: quantile(values, 0.95),
           p: Math.min(1, 2 * (Math.min(below, above) + 1) / (values.length + 1)) };
}

/** Trips grouped by the UTC day they opened, the unit `dayBootstrap` resamples. */
export function groupByDay(trips) {
  const days = new Map();
  for (const t of trips) {
    const key = Math.floor(t.openTime / 86_400_000);
    days.set(key, [...(days.get(key) || []), t]);
  }
  return [...days.values()];
}

/**
 * Each group's average pulled toward the overall average in proportion to how little data it
 * has (one-way random-effects, method-of-moments between-group variance; Efron & Morris 1975),
 * with a 90% interval. A group under `min` values gets `needs` instead. `chance` says how many
 * of the groups shown would clear the overall average by luck alone at 90%, and how many do.
 */
export function shrunkMeans(groups, { min = 8 } = {}) {
  const all = groups.flatMap(g => g.values);
  const n = all.length, k = groups.filter(g => g.values.length).length;
  if (!n) return { overall: null, groups: groups.map(g => ({ key: g.key, n: 0, total: 0, needs: min })), chance: { shown: 0, byChance: 0, clear: 0 } };
  const overall = mean(all);
  const means = groups.map(g => (g.values.length ? mean(g.values) : null));
  const within = n > k ? groups.reduce((s, g, i) => s + g.values.reduce((a, v) => a + (v - means[i]) ** 2, 0), 0) / (n - k) : 0;
  const between = groups.reduce((s, g, i) => s + (g.values.length ? g.values.length * (means[i] - overall) ** 2 : 0), 0);
  const scale = n - groups.reduce((s, g) => s + g.values.length ** 2, 0) / n;
  const tau2 = k > 1 && scale > 0 ? Math.max(0, (between - (k - 1) * within) / scale) : 0;
  const rows = groups.map((g, i) => {
    const size = g.values.length;
    const base = { key: g.key, n: size, total: g.values.reduce((s, v) => s + v, 0) };
    if (size < min) return { ...base, needs: min - size };
    const v = within / size;
    const weight = tau2 + v > 0 ? tau2 / (tau2 + v) : 0;
    const shrunk = overall + weight * (means[i] - overall);
    const half = Z90 * Math.sqrt((tau2 + v > 0 ? tau2 * v / (tau2 + v) : 0) + (1 - weight) ** 2 * within / n);
    return { ...base, mean: means[i], shrunk, ci: { lo: shrunk - half, hi: shrunk + half }, needs: 0 };
  });
  const shown = rows.filter(r => !r.needs);
  return { overall, tau: Math.sqrt(tau2), groups: rows,
           chance: { shown: shown.length, byChance: Math.round(shown.length * 0.1),
                     clear: shown.filter(r => r.ci.lo > overall || r.ci.hi < overall).length } };
}
