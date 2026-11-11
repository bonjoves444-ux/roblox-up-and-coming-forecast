// roblox-up-and-coming-forecast-01 entry: Monte Carlo rank simulator.
//
// Reads /input/history.ndjson (chart reads: rank, universe_id, name, playing)
// and /input/task.json, and writes /output/forecast.json:
//   { probabilities: [{universe_id, place, p}], top10: [universe_id x10] }
//
// Model (calibrated on the practice history; see README.md):
// - Each game's rank moves hourly by a band drift plus a persistent growth
//   drift plus an AR(1) velocity deviation (phi 0.65, rank-band volatility).
//   The growth drift comes from the game's log playing growth over the last
//   ~24h relative to the chart-wide mean growth (cancels the diurnal swing):
//   games growing faster than the field climb, slower ones fall. Rank
//   velocity itself does not predict 72h movement (corr ~0.05), so no
//   momentum from past rank changes is used.
// - New games enter deep in the chart at ~0.8/hour, anonymous: they occupy
//   places but are never named, so they feed the unnamed share. About 16%
//   are strong climbers. Games past rank 100 leave the chart.
// - 3000 seeded 72-hour trajectories; the time-averaged occupancy of each
//   place becomes its probability. Each place names at most 85% of its mass;
//   the rest is left unnamed for games the forecast cannot name (true new
//   entrants) plus model error.
//
// Deterministic: fixed seed, no wall-clock, no Math.random. Two runs on the
// same history produce byte-identical output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- seeded PRNG (mulberry32) ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box-Muller with the seeded rng.
function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0, s = 0;
    do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };
}

// ---- parameters (calibrated on the practice history; see README) ----
const SEED = 20261111;
const TRAJECTORIES = 3000;
const PHI = 0.65;            // hourly velocity autocorrelation; reproduces the observed 0.22 corr between 6h-block velocities
const GROWTH_K = 6; // persistent drift = -K * relative log playing growth/hr (tuned on practice + walk-forward backtests)
const ENTRANT_RATE = 0.8;    // anonymous new games per hour
const ENTRANT_ROCKET_P = 0.16; // share of entrants that are strong climbers
const OFF_CHART = 100;       // rank past this leaves the chart
const OFF_CHART_RANK = 105;  // starting rank for a game absent from the last read (just off the chart)
const MIN_P = 0.003;         // smallest probability row we emit
const MAX_ROWS_PER_PLACE = 100;
const NAMED_MASS_CAP = 0.85; // never name more than this of a place; rest unnamed
const SHRINK_TO_UNNAMED = 0.10; // extra mass moved from named rows to unnamed (model error)

// Rank-band drift (ranks/hour) and innovation sd of the velocity deviation
// (ranks/hour), calibrated so the simulated 6h rank displacement matches the
// history's: sd over ~6.4h gaps was 1.22/2.69/4.22/6.91/8.58/9.34 ranks by band,
// and with PHI=0.65 the 6h displacement sd is 5.66x the innovation sd.
// Bands: [1-5, 6-10, 11-20, 21-40, 41-70, 71-100]
const BANDS = [
  { lo: 1, hi: 5, drift: 0.04, sd: 0.22 },
  { lo: 6, hi: 10, drift: 0.14, sd: 0.48 },
  { lo: 11, hi: 20, drift: 0.14, sd: 0.75 },
  { lo: 21, hi: 40, drift: 0.13, sd: 1.22 },
  { lo: 41, hi: 70, drift: 0.02, sd: 1.52 },
  { lo: 71, hi: 100, drift: -0.35, sd: 1.65 },
];
function bandOf(rank: number): { drift: number; sd: number } {
  for (const b of BANDS) if (rank >= b.lo && rank <= b.hi) return b;
  return BANDS[BANDS.length - 1]!;
}

interface Obs { t: number; rank: number; playing: number | null }
interface Game {
  id: number;
  rank: number;      // current rank (continuous in sim)
  vel: number;       // velocity deviation from drift (ranks/hour; negative = climbing)
  drift: number;     // persistent drift (ranks/hour; negative = climbing)
  named: boolean;
}

function main(): void {
  const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
    places: number; output: string;
    window: { slots: number; slot_minutes: number };
  };
  const places = task.places ?? 10;
  const hours = task.window?.slots ?? 72;
  const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
    .split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as {
      at: string;
      up_and_coming: Array<{ rank: number; universe_id: number; playing: number | null }>;
    });
  if (lines.length === 0) throw new Error('empty history');
  const lastAt = new Date(lines[lines.length - 1]!.at).getTime();

  // Build per-game observations.
  const games = new Map<number, Obs[]>();
  for (const line of lines) {
    const t = new Date(line.at).getTime();
    for (const g of line.up_and_coming) {
      if (!games.has(g.universe_id)) games.set(g.universe_id, []);
      games.get(g.universe_id)!.push({ t, rank: g.rank, playing: g.playing ?? null });
    }
  }

  // Chart-wide mean log playing growth over the last ~24h (for relative growth).
  let meanGrowth = 0;
  {
    const t24 = lastAt - 24 * 3600 * 1000;
    let idxOld = -1;
    for (let i = lines.length - 2; i >= 0; i--) {
      if (new Date(lines[i]!.at).getTime() <= t24) { idxOld = i; break; }
    }
    if (idxOld >= 0) {
      const oldMap = new Map(lines[idxOld]!.up_and_coming.map((g) => [g.universe_id, g.playing]));
      const dtH = Math.max(1, (lastAt - new Date(lines[idxOld]!.at).getTime()) / 3600000);
      let sum = 0, n = 0;
      for (const g of lines[lines.length - 1]!.up_and_coming) {
        const p0 = oldMap.get(g.universe_id);
        if (p0 != null && p0 > 0 && g.playing != null && g.playing > 0) {
          sum += Math.log(g.playing / p0) / dtH; n++;
        }
      }
      if (n > 0) meanGrowth = sum / n;
    }
  }

  // Initial state for named games: those seen in the last 48h of history.
  const cutoff = lastAt - 48 * 3600 * 1000;
  const initial: Array<{ id: number; rank: number; vel: number; drift: number }> = [];
  for (const [id, obs] of games) {
    const recent = obs.filter((o) => o.t >= cutoff);
    if (recent.length === 0) continue;
    const lastObs = obs[obs.length - 1]!;
    const inLastRead = lastObs.t === lastAt;
    // Current rank: last observed rank, or off-chart (105) if not in the last read.
    const rank = inLastRead ? lastObs.rank : OFF_CHART_RANK;
    // Initial velocity deviation is 0: past rank velocity does not predict
    // 72h movement (corr ~0.05), so the AR(1) starts from rest and the
    // persistent growth drift below carries the signal.
    const vel = 0;
    const t24 = lastAt - 24 * 3600 * 1000;
    const older = [...obs].reverse().find((o) => o.t <= t24) ?? obs[0]!;
    const dtH = Math.max(1, (lastObs.t - older.t) / 3600000);
    // Persistent growth drift from log playing growth over the last ~24h,
    // relative to the chart-wide mean growth over the same window (cancels the
    // common diurnal swing: all games' playing moves together by time of day).
    // A game growing faster than the field climbs; one growing slower falls.
    // Clamped so a noisy spike cannot dominate.
    let drift = 0;
    if (inLastRead && lastObs.playing != null && older.playing != null && older.playing > 0 && lastObs.playing > 0) {
      const g24 = Math.log(lastObs.playing / older.playing) / dtH;
      const gRel = g24 - meanGrowth;
      const gClamped = Math.min(0.10, Math.max(-0.05, gRel));
      drift = -GROWTH_K * gClamped;
    }
    // A game absent from the last read has unknown drift; give it 0.
    if (!inLastRead) { drift = 0; }
    initial.push({ id, rank, vel, drift });
  }
  // Sort by rank so the top of the chart is first (deterministic order).
  initial.sort((a, b) => a.rank - b.rank || a.id - b.id);

  // Occupancy counts: counts[place][gameId] = trajectory-hours at that place.
  const counts = new Map<number, Map<number, number>>();
  for (let k = 1; k <= places; k++) counts.set(k, new Map());
  const totalHours = TRAJECTORIES * hours;

  const rng = mulberry32(SEED);
  const gauss = makeGaussian(rng);

  for (let traj = 0; traj < TRAJECTORIES; traj++) {
    // Fresh agent list per trajectory.
    const agents: Game[] = initial.map((g) => ({ id: g.id, rank: g.rank, vel: g.vel, drift: g.drift, named: true }));
    let anonId = -1;
    for (let h = 0; h < hours; h++) {
      // Spawn anonymous entrants (Poisson-ish via Bernoulli per hour on rate<1).
      // A rocket entrant gets a strong persistent climbing drift; the rest get
      // a small drift that mostly fades them out.
      if (rng() < ENTRANT_RATE) {
        const rocket = rng() < ENTRANT_ROCKET_P;
        agents.push({
          id: anonId--, rank: 73 + rng() * 25, // entry rank ~73-98
          vel: 0,
          drift: rocket ? -(1.0 + rng() * 1.0) : (rng() - 0.3) * 0.6,
          named: false,
        });
      }
      // Update each agent: the velocity deviation is AR(1), and the rank
      // moves by the band drift plus the persistent drift plus the deviation.
      for (const a of agents) {
        const b = bandOf(a.rank);
        a.vel = PHI * a.vel + gauss() * b.sd;
        a.rank += b.drift + a.drift + a.vel;
        if (a.rank < 1) a.rank = 1;
      }
      // Drop agents past the chart.
      for (let i = agents.length - 1; i >= 0; i--) {
        if (agents[i]!.rank > OFF_CHART + 5) agents.splice(i, 1);
      }
      // Top `places` by rank (partial selection: single scan keeping the best 10).
      const top: Game[] = [];
      for (const a of agents) {
        if (a.rank > OFF_CHART) continue;
        // insert into top keeping it sorted by rank, capped at `places`
        let pos = top.length;
        while (pos > 0 && top[pos - 1]!.rank > a.rank) pos--;
        if (pos < places) {
          top.splice(pos, 0, a);
          if (top.length > places) top.pop();
        }
      }
      for (let k = 0; k < top.length; k++) {
        const g = top[k]!;
        if (!g.named) continue;
        const m = counts.get(k + 1)!;
        m.set(g.id, (m.get(g.id) ?? 0) + 1);
      }
    }
  }

  // Convert counts to probabilities, with shrinkage to the unnamed share.
  const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
  for (let k = 1; k <= places; k++) {
    const m = counts.get(k)!;
    // Raw probabilities.
    const rows: Array<{ id: number; p: number }> = [];
    let rawSum = 0;
    for (const [id, c] of m) {
      const p = (c / totalHours) * (1 - SHRINK_TO_UNNAMED);
      rows.push({ id, p });
      rawSum += p;
    }
    // Cap the named mass per place; scale down if over the cap.
    if (rawSum > NAMED_MASS_CAP) {
      const f = NAMED_MASS_CAP / rawSum;
      for (const r of rows) r.p *= f;
      rawSum = NAMED_MASS_CAP;
    }
    rows.sort((a, b) => b.p - a.p || a.id - b.id);
    let kept = 0;
    for (const r of rows) {
      if (r.p < MIN_P) break;
      if (kept >= MAX_ROWS_PER_PLACE) break;
      probabilities.push({ universe_id: r.id, place: k, p: Math.round(r.p * 1e6) / 1e6 });
      kept++;
    }
  }

  // top10: order games by total top-10 probability, then by best single-place p.
  const total = new Map<number, number>();
  const best = new Map<number, number>();
  for (const r of probabilities) {
    total.set(r.universe_id, (total.get(r.universe_id) ?? 0) + r.p);
    best.set(r.universe_id, Math.max(best.get(r.universe_id) ?? 0, r.p));
  }
  const top10 = [...total.entries()]
    .sort((a, b) => b[1] - a[1] || (best.get(b[0])! - best.get(a[0])!) || a[0] - b[0])
    .slice(0, places)
    .map(([id]) => id);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top10 })}\n`);
}

main();
