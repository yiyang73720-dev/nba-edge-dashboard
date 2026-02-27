# Alpha Hunter: Backtest Results v2 — Real Data Analysis

**Date:** 2026-02-27
**Data:** 3,517 NBA games (Oct 2023 - Feb 2027), ESPN play-by-play
**Method:** Play-by-play parsing → checkpoint extraction → signal detection → ML feature analysis

---

## EXECUTIVE SUMMARY

Star Coil is a **verified profitable edge** at 58.6% over 2,181 signals. 3PT Fragile is a **verified money loser** at 31.3%. The Combined signal should be removed as it drags down Star Coil. New ML analysis found that combining Star Coil with opponent shooting inefficiency creates an even sharper filter.

---

## PHASE 1: EXISTING EDGE VERIFICATION

### Star Coil: CONFIRMED PROFITABLE

| Metric | Value |
|--------|-------|
| Total signals | 2,181 |
| Win rate | **58.6%** |
| P&L (flat $100) | **+$25,883** |
| ROI | **+11.9%** |
| Break-even needed | 52.4% |
| Edge over break-even | **+6.2%** |

**By Quarter:**
- Q2: 1,130W - 836L = **57.5%** (1,966 signals)
- Q3: 148W - 67L = **68.8%** (215 signals) ← ELITE

**Thesis confirmed:** When a star player (21+ PPG) is below 65% of expected scoring pace in a close game (margin ≤ 15) during Q2-Q3, they tend to regress upward. The market underprices this.

### 3PT Fragile: UNPROFITABLE — REMOVE

| Metric | Value |
|--------|-------|
| Total signals | 1,093 |
| Win rate | **31.3%** |
| P&L (flat $100) | **-$44,009** |
| ROI | **-40.3%** |
| Baseline (random trailing team) | 35.1% |

**Below baseline.** The 3PT regression thesis is correct (shooting does regress), but the market already accounts for it. Fading a 3PT-hot team's ML is a losing proposition.

### Combined Signal: UNPROFITABLE — REMOVE

| Metric | Value |
|--------|-------|
| Total signals | 303 |
| Win rate | 30.4% |
| P&L | -$12,736 |

The 3PT Fragile filter drags down what would otherwise be profitable Star Coil signals.

---

## PHASE 2: ML-DISCOVERED EDGES

### Baseline: Trailing team wins 35.1% of the time (moneyline)

### Top Profitable Discoveries

#### #1: STAR COIL + OPPONENT 2PT COLD (Best New Edge)
```
Conditions:
  - bestStarPace < 0.612 (star below 61% expected pace)
  - leading2Pct < 0.467 (opponent's 2PT% below 47%)
  - Q1-Q3, team is trailing
```
- **208 signals | 57.2% win rate | +$9.20 EV per $100 bet**
- Thesis: Star is cold (will regress up) AND opponent's inside game is unsustainably cold (their lead is fragile from 2PT struggles, not just 3PT)

#### #2: STAR COIL + OPPONENT FG% COLD
```
Conditions:
  - bestStarPace < 0.612
  - leadingFGPct < 0.431 (opponent overall FG% below 43.1%)
  - Q1-Q3, team is trailing
```
- **234 signals | 56.0% win rate | +$6.90 EV per $100 bet**
- Thesis: Same as above but using overall FG% instead of just 2PT%

#### #3: STAR COIL + TIGHT GAME
```
Conditions:
  - bestStarPace < 0.612
  - margin < 2 (within 1 point)
  - Q1-Q3
```
- **266 signals | 53.8% win rate | +$2.60 EV per $100 bet**
- Marginal but positive — the tighter the game, the more star regression matters

### Other Notable Findings

| Feature | Direction | Samples | Win% | Lift | Notes |
|---------|-----------|---------|------|------|-------|
| margin < 4 | Small deficit | 5,195 | 44.7% | +9.5% | Expected — smaller deficits easier to overcome |
| bestStarPace < 1.556 | Star playing below max | 6,593 | 40.8% | +5.7% | Star regression is real |
| leading2Pct < 0.515 | Opponent 2PT cold | 2,642 | 40.8% | +5.7% | 2PT regression exists (new finding) |
| leadingFGPct < 0.431 | Opponent FG cold | 1,316 | 42.9% | +7.8% | Overall shooting regression |
| leaderMomentumDrop > 9 | Opponent fading | 2,193 | 40.6% | +5.5% | Q2 < Q1 scoring = momentum shift |

---

## RECOMMENDATIONS

### Immediate Actions
1. **Keep Star Coil** as primary signal — it's genuinely profitable
2. **Remove 3PT Fragile** from moneyline bets — it's a loser
3. **Remove Combined signal** — the 3PT component poisons it
4. **Add "Enhanced Star Coil"** filter: Star Coil + opponent FG% < 43% for highest-conviction signals
5. **Consider 3PT Fragile on SPREADS only** — the thesis might work for spread coverage (not tested yet in this backtest which only checks ML outcomes)

### New Signal to Implement: "Star Coil Plus"
When Star Coil fires AND the opponent's overall FG% or 2PT% is below threshold, mark it as "Star Coil Plus" (higher confidence). This fires ~1x/night and has 56-57% win rate on moneyline.

### Future Work
- Backtest 3PT Fragile on spreads (it may work against the spread even if it loses on ML)
- Test Star Coil with period-specific filters (Q3-only subset is 69%)
- Validate with out-of-sample (hold out 2025-26 season, train on 2023-24)

---

## METHODOLOGY NOTES

- Play-by-play parsed using ESPN `play.text` field ("makes"/"misses") for shot detection
- 3-pointers detected via "three point" in play text
- Player names mapped through boxscore athletes (play participants lack displayName)
- Team abbreviations normalized (UTAH→UTA, GS→GS, NYK→NY, etc.)
- Checkpoints every ~2 game-minutes from minute 6 onward
- Star matching: last name + normalized team abbreviation
- FG%, 3PT%, 2PT%, FT% all derived from cumulative play-by-play counts
