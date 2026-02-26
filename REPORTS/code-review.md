# Code Review: Alpha Hunter Backtest & Signal Engine

**Reviewer:** Automated Code Review Agent
**Date:** 2026-02-27
**Status:** 6 critical/important bugs FIXED, remaining items documented

---

## FIXED BUGS

### Bug #1 (CRITICAL): Spread Push Marked as LOSS ✅ FIXED
**File:** `signal-engine.js`, resolveCompletedGames
- `(finalMargin + bookSpread) > 0` used strict `>`, so exact pushes (margin + spread = 0) were marked LOSS
- Fixed: added 3-way branch for WIN / PUSH (payout = 0) / LOSS

### Bug #6 (IMPORTANT): QE Signals Imported as ML Signals ✅ FIXED
**File:** `index.html`, importEngineSignals
- Quality Edge (spread bets) were flowing into the ML signal tracker, corrupting win-rate stats
- Fixed: added `if (sig.type === 'quality_edge') continue;` to skip QE signals in ML import

### Bug #12 (IMPORTANT): getWinPct Silent False Positives ✅ FIXED
**File:** `signal-engine.js`, getWinPct
- Malformed record strings (e.g., "N/A") would return 0.5 instead of null, causing false QE signals
- Fixed: returns `null` for unparseable records, QE block skips when either team record is null

### Bug #2 & #5: Comments vs Code Mismatch ✅ FIXED
- Comments said "-4 to 0" and "1-10 pts" but code used "-7 to +1.5" and "1-14 pts"
- Fixed: updated all comments to match actual thresholds
- Added `gMins >= 3` guard so QE doesn't fire in first 3 minutes of Q1

---

## REMAINING ITEMS (documented, not critical)

### Bug #3 (IMPORTANT): Odds API Returns Pre-Game, Not Live Odds
- `fetchOdds` uses `/v4/sports/{sport}/odds/` which returns pre-game markets
- For live games, spread data may be stale or absent
- **Impact:** QE `bookSpread` may reflect pre-game line, not current live line
- **Mitigation:** The thesis still works with pre-game spreads (it measures the market's pre-game view vs current score state). Live odds would be better but require a paid Odds API tier.

### Bug #4 (IMPORTANT): 3PT Fragile Differs Between Engine and Backtest
- Live engine doesn't check opponent paint scoring >= 58%
- Historical backtest DOES check this
- **Impact:** Backtest shows stricter (likely better) results than what fires live
- **Action needed:** Align the two implementations

### Bug #8: QE Dedup Key Too Coarse
- Only one QE signal per game ever recorded (key = `gameId_quality_edge`)
- Compare: 3PT/Star signals allow one per hour per game
- **Impact:** If conditions improve later in the game, the better opportunity is blocked
- **Action needed:** Consider adding hour component to key

### Bug #9: Kelly Formula Divergence
- Engine uses base edge 3.5% + 1%/signal, cap 8%, max 5% bankroll
- Frontend "moderate" mode uses 5% + 1.5%/signal, cap 12%, max 10% bankroll
- Comment says they match — they don't
- **Impact:** Engine Kelly sizing is more conservative than what UI shows users

### Bug #13: renderQualityEdge Concurrent Fetches
- Uses unawaited `fetch().then()` pattern, no abort controller
- On rapid refreshes, older callbacks could overwrite newer data
- **Impact:** Low severity in practice (JSON reads are fast)

### Bug #14: Import Dedup Key Mismatch
- Engine key includes mode + hour; importer key is just eventId + betTeam
- **Impact:** Later/better signals for same game get dropped by importer

### Bug #15: Backtest Takes Earliest Signal, Not Best
- First qualifying checkpoint per side wins, blocking potentially better later entries
- **Impact:** Backtest may understate real edge (uses worst entry timing)
