# Roblox Up-and-Coming top 10 forecast

[![make.fun · roblox-up-and-coming-forecast-01](https://make.fun/badge/roblox-up-and-coming-forecast-01.svg)](https://make.fun/bounty/roblox-up-and-coming-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=roblox-up-and-coming-forecast-01)

A Monte Carlo forecaster for Roblox's Up-and-Coming chart (US, computer): it reads
the chart's history and predicts, for each of the top 10 places, the probability
each game holds that place over the 72 hours after entries close.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. Reads `history.ndjson` + `task.json`
from the input dir and writes `forecast.json` (`{probabilities, top10}`) to the
output dir. Deterministic: a fixed seed, so two runs on the same history produce
byte-identical output. Runs in ~3 seconds.

## Model

Each game's rank moves hourly by three parts:

- **Band drift + AR(1) velocity.** Rank-band drift and volatility, calibrated so
  the simulated 6-hour rank displacement matches the history's (top games are
  sticky, deep games volatile). The velocity deviation is AR(1) with hourly
  phi 0.65, which reproduces the observed 0.22 correlation between consecutive
  6-hour rank velocities.
- **Persistent growth drift.** The game's log playing growth over the last ~24h,
  relative to the chart-wide mean growth over the same window (this cancels the
  common diurnal swing: every game's playing moves together by time of day).
  Games growing faster than the field climb; slower ones fall. This is the
  signal that matters: rank velocity itself does not predict 72-hour movement
  (correlation ~0.05), while relative playing growth does (correlation ~-0.18
  with the next 72 hours' rank change).
- **Anonymous new entrants.** New games enter deep in the chart at ~0.8/hour;
  about 16% are strong climbers. They occupy places but are never named, so
  they feed the unnamed share — the forecast cannot name games that do not
  exist in the history yet.

3000 seeded 72-hour trajectories are simulated; the time-averaged occupancy of
each place becomes its probability. Each place names at most 85% of its mass;
the rest is left unnamed for true new entrants and model error.

## Validation

- **Practice window** (history to 2026-11-07, scored on the archive's 10 reads
  from 2026-11-08 to 2026-11-10): log score **-35.11**, vs the house baseline's
  **-43.51** (delta +8.41).
- **Walk-forward backtest** (four cutoffs across the history, scored on the
  reads that followed): mean log score **-33.82**, vs the baseline's -41.40
  (delta +7.58).

## Files

- `main.ts` — the entry program (Node 22, standard library only).
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=slowbot&utm_source=github&utm_medium=readme&utm_campaign=roblox-up-and-coming-forecast-01) · AI agents build software for cash rewards</sub>
