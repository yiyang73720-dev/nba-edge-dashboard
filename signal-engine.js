#!/usr/bin/env node
// ============================================================
// ALPHA HUNTER — BACKGROUND SIGNAL ENGINE (DUAL MODE)
// Runs independently of the browser. Detects signals for BOTH
// NBA and NCAA simultaneously. Calculates Kelly sizing, saves
// everything to engine-signals.json. Also serves a local HTTP
// server so you can view the site at http://localhost:3000
//
// Usage:
//   node signal-engine.js              (default: both modes)
//   node signal-engine.js both         (nba + ncaab)
//   node signal-engine.js nba          (nba only)
//   node signal-engine.js ncaab        (ncaab only)
//
// Runs every 30 seconds per mode. Ctrl+C to stop.
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');

// === CONFIG ===
const ARG_MODE = (process.argv[2] || 'both').toLowerCase();
const MODES_TO_RUN = ARG_MODE === 'both' ? ['nba', 'ncaab'] : [ARG_MODE];
const REFRESH_INTERVAL = 30000; // 30 seconds
const HTTP_PORT = 3000;
const ODDS_API_KEY = '4ca2c6a2ed9e162809eb03722e2dc734';

const DATA_DIR = path.dirname(process.argv[1] || __filename);
const SIGNALS_FILE = path.join(DATA_DIR, 'engine-signals.json');
const STATE_FILE = path.join(DATA_DIR, 'engine-state.json');
const STARS_FILE = path.join(DATA_DIR, 'engine-stars.json');

// === THRESHOLD CONFIGS (NBA is set in stone, NCAA has its own values) ===
const CFG_NCAAB = {
  mode: 'ncaab',
  league: 'NCAAB',
  espnUrl: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
  oddsSport: 'basketball_ncaab',
  totalMins: 40, periodLen: 20, regPeriods: 2, otPeriod: 3,
  league3PtAvg: 33.5, fragileThreshold: 40,
  hotCheck: (pn, an) => (pn >= 48 && an >= 10) || (pn >= 52 && an >= 7),
  warmCheck: (pn, an) => (pn >= 43 && an >= 8),
  engineThreshold: 1.1, fragileMaxMargin: 12,
  coilMaxMargin: 12, coilWindow: (gMins) => gMins >= 8 && gMins <= 35,
  starPpgMin: 16,
  // Soft combined (loosened for NCAA)
  softHotCheck: (pn, an) => (pn >= 40 && an >= 7) || (pn >= 45 && an >= 5),
  softFragilePct: 36, softMaxLd: 18, softMinScore: 12,
  softStarPace: 0.80, softStarMargin: 18, softStarWindow: (gMins) => gMins >= 4 && gMins <= 37,
  softCastAcceptWeak: true,
  homeCourtBoost: 0.5,
};

const CFG_NBA = {
  mode: 'nba',
  league: 'NBA',
  espnUrl: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  oddsSport: 'basketball_nba',
  totalMins: 48, periodLen: 12, regPeriods: 4, otPeriod: 5,
  league3PtAvg: 36.5, fragileThreshold: 42,
  hotCheck: (pn, an) => (pn >= 50 && an >= 12) || (pn >= 55 && an >= 8),
  warmCheck: (pn, an) => (pn >= 45 && an >= 10),
  engineThreshold: 1.3, fragileMaxMargin: 15,
  coilMaxMargin: 15, coilWindow: (gMins, per) => per >= 2 && per <= 3,
  starPpgMin: 21,
  // Soft combined (NBA original)
  softHotCheck: (pn, an) => (pn >= 45 && an >= 10) || (pn >= 50 && an >= 8),
  softFragilePct: 38, softMaxLd: 18, softMinScore: 15,
  softStarPace: 0.75, softStarMargin: 18, softStarWindow: (gMins, per) => per >= 1 && per <= 3,
  softCastAcceptWeak: false,
  homeCourtBoost: 0, // NBA: no home court booster
};

function getCFG(mode) { return mode === 'ncaab' ? CFG_NCAAB : CFG_NBA; }

// === STATE (shared signal log, per-mode sub-state) ===
let engineState = {
  nba: { scoreHistory: {}, oddsCache: {}, oddsCacheTime: 0 },
  ncaab: { scoreHistory: {}, oddsCache: {}, oddsCacheTime: 0 },
};
let signalLog = [];
let starDBs = { nba: [], ncaab: [] };

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Handle migration from old single-mode state
    if (raw.scoreHistory && !raw.nba) {
      // Old format — migrate
      engineState.ncaab = { scoreHistory: raw.scoreHistory || {}, oddsCache: raw.oddsCache || {}, oddsCacheTime: raw.oddsCacheTime || 0 };
      engineState.nba = { scoreHistory: {}, oddsCache: {}, oddsCacheTime: 0 };
    } else {
      engineState = raw;
    }
    // Ensure both keys exist
    if (!engineState.nba) engineState.nba = { scoreHistory: {}, oddsCache: {}, oddsCacheTime: 0 };
    if (!engineState.ncaab) engineState.ncaab = { scoreHistory: {}, oddsCache: {}, oddsCacheTime: 0 };
  } catch(e) { /* fresh */ }
  try { signalLog = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); } catch(e) { signalLog = []; }
  try {
    const raw = JSON.parse(fs.readFileSync(STARS_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      // Old format — assume NCAA
      starDBs.ncaab = raw;
    } else {
      starDBs = raw;
    }
    if (!starDBs.nba) starDBs.nba = [];
    if (!starDBs.ncaab) starDBs.ncaab = [];
  } catch(e) { starDBs = { nba: [], ncaab: [] }; }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(engineState, null, 2));
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signalLog, null, 2));
}
function saveStars() {
  fs.writeFileSync(STARS_FILE, JSON.stringify(starDBs, null, 2));
}

// === HELPERS (all take CFG as parameter now) ===
function getElapsedMinutes(cfg, per, clk) {
  const parts = (clk || '0:00').split(':');
  const cM = parseFloat(parts[0]) || 0;
  const cS = parseFloat(parts[1]) || 0;
  return (per - 1) * cfg.periodLen + (cfg.periodLen - cM - cS / 60);
}
function getGamePct(cfg, per, clk) {
  return Math.min(getElapsedMinutes(cfg, per, clk) / cfg.totalMins, 1);
}
function getExpectedByTime(cfg, ppg, mins) { return ppg * (mins / cfg.totalMins); }
function periodLabel(cfg, per) {
  if (cfg.mode === 'ncaab') return per <= 2 ? `H${per}` : `OT${per - 2}`;
  return `Q${per}`;
}

// === SCORING DURABILITY ===
function analyzeScoringDurability(cfg, score, fg3Made, opponentScore) {
  const s = parseInt(score) || 0;
  const m3 = parseInt(fg3Made) || 0;
  if (s <= 0) return { pct3: 0, fragile: false };
  const pts3 = m3 * 3;
  const pct3 = pts3 / s * 100;
  const isLeading = s > (parseInt(opponentScore) || 0);
  const fragile = pct3 >= cfg.fragileThreshold && isLeading && s >= 20;
  return { pct3, fragile, pts3, nonThreePts: s - pts3 };
}

// === SUPPORTING CAST ===
function analyzeSupportingCast(cfg, starPts, teamScore, oppScore, starPpg, gMins) {
  const castScore = teamScore - starPts;
  const castGap = castScore - oppScore;
  const starExpected = getExpectedByTime(cfg, starPpg, gMins);
  const starDeficit = Math.max(0, starExpected - starPts);
  const regressionFlips = starDeficit > Math.abs(Math.min(castGap, 0));
  const strong = castGap >= -8;
  const moderate = castGap >= -15 && castGap < -8;
  return { castScore, castGap, starExpected, starDeficit, regressionFlips, strong, moderate };
}

// === DAMAGE LOCKED ===
function trackScoreMomentum(modeState, gameId, aS, hS) {
  if (!modeState.scoreHistory[gameId]) modeState.scoreHistory[gameId] = [];
  const hist = modeState.scoreHistory[gameId];
  const now = Date.now();
  if (hist.length === 0 || (now - hist[hist.length - 1].ts) >= 25000) {
    hist.push({ ts: now, aS, hS });
  }
  if (hist.length > 15) hist.splice(0, hist.length - 15);
}

function analyzeDamageLocked(modeState, gameId, teamSide, gMins) {
  const hist = modeState.scoreHistory[gameId];
  if (!hist || hist.length < 4) return { locked: false };
  if (gMins < 15) return { locked: false };
  const recent = hist.slice(-Math.max(4, hist.length));
  const first = recent[0], last = recent[recent.length - 1];
  const timeSpanMs = last.ts - first.ts;
  if (timeSpanMs < 180000) return { locked: false };
  if ((last.aS + last.hS) === (first.aS + first.hS)) return { locked: false };
  const getDeficit = (snap) => teamSide === 'away' ? (snap.hS - snap.aS) : (snap.aS - snap.hS);
  const deficitNow = getDeficit(last);
  const deficitThen = getDeficit(first);
  const deficitChange = deficitNow - deficitThen;
  const isTrailing = deficitNow > 0;
  const deficitStable = deficitChange >= 0;
  let consistentlyBehind = true;
  for (let i = 1; i < recent.length; i++) {
    if ((getDeficit(recent[i - 1]) - getDeficit(recent[i])) > 3) { consistentlyBehind = false; break; }
  }
  return { locked: isTrailing && deficitStable && consistentlyBehind, deficitNow, deficitThen };
}

// === BET RECOMMENDATION ===
function getRecommendation(cfg, aS, hS, per, clk, signalLevel) {
  const margin = Math.abs(hS - aS);
  const gameMinElapsed = getElapsedMinutes(cfg, per, clk);
  const gameMinRemaining = Math.max(0, cfg.totalMins - gameMinElapsed);
  let rec = { type: 'WATCH', margin, minRemaining: Math.round(gameMinRemaining) };
  if (per >= cfg.otPeriod) return rec;
  if (gameMinRemaining < 3) return rec;
  if (signalLevel < 2) return rec;
  let type, units;
  if (margin <= 5) { type = 'ML'; units = 1.5; }
  else if (margin <= 15) { type = 'SPREAD'; units = margin <= 10 ? 1.5 : 1; }
  else if (margin <= 20) { type = 'SPREAD'; units = 1; }
  else return rec;
  if (gameMinRemaining < 6) {
    if (type === 'ML') type = 'SPREAD';
    else if (margin > 15) return rec;
    units = Math.min(units, 1);
  }
  return { type, margin, minRemaining: Math.round(gameMinRemaining), units };
}

// === KELLY ===
function kellySize(impliedP, odds, signalCount) {
  const edge = signalCount >= 3 ? 0.12 : signalCount >= 2 ? 0.08 : 0.05;
  const p = Math.min(0.90, impliedP + edge);
  const q = 1 - p;
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  let fStar = (b * p - q) / b;
  if (fStar < 0) fStar = 0;
  fStar = fStar * 0.5; // half-Kelly
  if (fStar > 0.05) fStar = 0.05;
  if (fStar > 0 && fStar < 0.005) fStar = 0.005;
  const bankroll = 20000;
  const bet = Math.max(0, Math.round(bankroll * fStar));
  return { bet, fStar: Math.round(fStar * 1000) / 10, p: Math.round(p * 1000) / 10, edge: Math.round(edge * 1000) / 10 };
}

// === ODDS ===
async function fetchOdds(cfg) {
  const modeState = engineState[cfg.mode];
  const now = Date.now();
  if (now - modeState.oddsCacheTime < 120000 && Object.keys(modeState.oddsCache).length > 0) return;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${cfg.oddsSport}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&bookmakers=fanduel,draftkings,betmgm`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    const cache = {};
    for (const g of data) {
      for (const bk of (g.bookmakers || [])) {
        const mk = bk.markets?.find(m => m.key === 'h2h');
        if (!mk) continue;
        const ho = mk.outcomes?.find(o => o.name === g.home_team);
        const ao = mk.outcomes?.find(o => o.name === g.away_team);
        if (ho && ao) {
          const key = (g.away_team + ' vs ' + g.home_team).toLowerCase();
          cache[key] = { homeML: ho.price, awayML: ao.price, home: g.home_team, away: g.away_team };
          cache[g.home_team.toLowerCase()] = cache[key];
          cache[g.away_team.toLowerCase()] = cache[key];
        }
        break; // first bookmaker is enough
      }
    }
    modeState.oddsCache = cache;
    modeState.oddsCacheTime = now;
  } catch (e) { /* keep existing cache */ }
}

function matchOdds(modeState, aAbbr, hAbbr, aFull, hFull) {
  const c = modeState.oddsCache;
  if (!c || Object.keys(c).length === 0) return null;
  const key1 = (aFull + ' vs ' + hFull).toLowerCase();
  if (c[key1]) return c[key1];
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (!v.home || !v.away) continue;
    const hm = v.home.toLowerCase();
    const am = v.away.toLowerCase();
    if ((hFull.toLowerCase().includes(hm.split(' ').pop()) || hm.includes(hFull.toLowerCase().split(' ').pop())) &&
        (aFull.toLowerCase().includes(am.split(' ').pop()) || am.includes(aFull.toLowerCase().split(' ').pop()))) {
      return v;
    }
  }
  return null;
}

// === NCAA STAR DATABASE ===
async function buildStarDB(cfg) {
  if (cfg.mode !== 'ncaab') return; // NBA uses hardcoded stars
  const db = starDBs.ncaab;
  // Check cache freshness (24h)
  if (db.length > 0) {
    try {
      const stat = fs.statSync(STARS_FILE);
      if (Date.now() - stat.mtimeMs < 86400000) {
        log(`[${cfg.league}] Star DB cached: ${db.length} stars`);
        return;
      }
    } catch(e) { /* rebuild */ }
  }
  log(`[${cfg.league}] Building NCAA star database from ESPN...`);
  try {
    const sbResp = await fetch(cfg.espnUrl);
    const sbData = await sbResp.json();
    const teams = [];
    for (const e of (sbData.events || [])) {
      for (const c of (e.competitions?.[0]?.competitors || [])) {
        const tid = c.team?.id;
        const abbr = c.team?.abbreviation || '';
        if (tid && !teams.find(t => t.id === tid)) teams.push({ id: tid, abbr });
      }
    }
    log(`[${cfg.league}] Found ${teams.length} teams in today's games`);
    const stars = [];
    for (let i = 0; i < teams.length; i += 5) {
      const batch = teams.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(async (team) => {
        const lUrl = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/seasons/2026/types/2/teams/${team.id}/leaders`;
        const lResp = await fetch(lUrl);
        if (!lResp.ok) return [];
        const lData = await lResp.json();
        const ptsCat = (lData.categories || []).find(c => c.name === 'pointsPerGame' || c.name === 'points' || c.displayName === 'Points Per Game');
        if (!ptsCat) return [];
        const found = [];
        for (const leader of (ptsCat.leaders || []).slice(0, 3)) {
          const ppg = leader.value || 0;
          if (ppg < cfg.starPpgMin) continue;
          const ref = leader.athlete?.$ref || leader.athlete?.href;
          if (!ref) continue;
          try {
            const aResp = await fetch(ref);
            if (!aResp.ok) continue;
            const aData = await aResp.json();
            found.push({ name: aData.displayName || aData.shortName || '?', team: team.abbr, ppg });
          } catch(e) { /* skip */ }
        }
        return found;
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) stars.push(...r.value);
      }
    }
    starDBs.ncaab = stars;
    saveStars();
    log(`[${cfg.league}] Star DB built: ${stars.length} stars`);
  } catch(e) {
    log(`[${cfg.league}] Star DB build failed: ${e.message}`);
  }
}

// NBA default stars (21+ PPG — 2025-26 season)
const NBA_STARS = [
  {name:'Luka Doncic',team:'LAL',ppg:32.5},{name:'Shai Gilgeous-Alexander',team:'OKC',ppg:31.8},
  {name:'Anthony Edwards',team:'MIN',ppg:29.6},{name:'Jaylen Brown',team:'BOS',ppg:29.2},
  {name:'Tyrese Maxey',team:'PHI',ppg:29.1},{name:'Nikola Jokic',team:'DEN',ppg:28.8},
  {name:'Donovan Mitchell',team:'CLE',ppg:28.5},{name:'Kawhi Leonard',team:'LAC',ppg:28.0},
  {name:'Lauri Markkanen',team:'UTA',ppg:26.7},{name:'Jalen Brunson',team:'NYK',ppg:26.7},
  {name:'Kevin Durant',team:'HOU',ppg:25.9},{name:'Jamal Murray',team:'DEN',ppg:25.5},
  {name:'Cade Cunningham',team:'DET',ppg:25.3},{name:'Devin Booker',team:'PHX',ppg:24.7},
  {name:'Michael Porter Jr.',team:'BKN',ppg:24.6},{name:'James Harden',team:'LAC',ppg:24.5},
  {name:'Deni Avdija',team:'POR',ppg:24.4},{name:'Victor Wembanyama',team:'SAS',ppg:24.2},
  {name:'Pascal Siakam',team:'IND',ppg:23.9},{name:'Keyonte George',team:'UTA',ppg:23.8},
  {name:'Jalen Johnson',team:'ATL',ppg:23.0},{name:'Norman Powell',team:'MIA',ppg:22.9},
  {name:'Trey Murphy III',team:'NOP',ppg:21.9},{name:'Julius Randle',team:'MIN',ppg:21.9},
  {name:'Zion Williamson',team:'NOP',ppg:21.8},
];

function getStars(cfg) { return cfg.mode === 'ncaab' ? starDBs.ncaab : NBA_STARS; }

function matchStar(cfg, leaderName, leaderTeam) {
  const stars = getStars(cfg);
  const leaderLast = leaderName.toLowerCase().split(' ').pop();
  return stars.find(s => {
    const starLast = s.name.split(' ').pop().toLowerCase();
    return leaderLast === starLast && s.team === leaderTeam;
  });
}

// === MAIN SIGNAL DETECTION (for one mode) ===
async function detectSignals(cfg) {
  const modeState = engineState[cfg.mode];
  const isNCAA = cfg.mode === 'ncaab';
  try {
    const resp = await fetch(cfg.espnUrl);
    if (!resp.ok) { log(`[${cfg.league}] ESPN error: ${resp.status}`); return; }
    const data = await resp.json();
    const events = data.events || [];
    const liveEvents = events.filter(e => e.status?.type?.state === 'in');

    if (liveEvents.length === 0) {
      log(`[${cfg.league}] No live games`);
      // Still resolve completed games
      await resolveCompletedGames(cfg, events);
      return;
    }

    log(`[${cfg.league}] ${liveEvents.length} live games — scanning...`);
    let newSignals = 0;

    for (const event of liveEvents) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) continue;

      const gid = event.id;
      const aA = away.team?.abbreviation || '';
      const hA = home.team?.abbreviation || '';
      const aFull = away.team?.displayName || '';
      const hFull = home.team?.displayName || '';
      const aS = parseInt(away.score) || 0;
      const hS = parseInt(home.score) || 0;
      const per = event.status?.period || 0;
      const clk = event.status?.displayClock || '';
      const gLabel = `${aA} @ ${hA}`;

      // Parse stats
      let aStats = {}, hStats = {};
      (away.statistics || []).forEach(s => { aStats[s.name] = s.displayValue; });
      (home.statistics || []).forEach(s => { hStats[s.name] = s.displayValue; });

      const a3P = parseFloat(aStats.threePointFieldGoalPct || aStats.threePointPct || 0);
      const h3P = parseFloat(hStats.threePointFieldGoalPct || hStats.threePointPct || 0);
      const a3M = parseInt(aStats.threePointFieldGoalsMade || 0);
      const h3M = parseInt(hStats.threePointFieldGoalsMade || 0);
      const a3A = parseInt(aStats.threePointFieldGoalsAttempted || 0);
      const h3A = parseInt(hStats.threePointFieldGoalsAttempted || 0);

      // Leaders
      let aLeaders = [], hLeaders = [];
      (comp.competitors || []).forEach(c => {
        (c.leaders || []).forEach(cat => {
          if (cat.name === 'points' || cat.displayName === 'Points') {
            (cat.leaders || []).forEach(l => {
              const e = { name: l.athlete?.shortName || l.athlete?.displayName || '?', pts: parseFloat(l.value) || 0, team: c.homeAway === 'away' ? aA : hA };
              if (c.homeAway === 'away') aLeaders.push(e); else hLeaders.push(e);
            });
          }
        });
      });

      // Track momentum
      trackScoreMomentum(modeState, gid, aS, hS);

      const gMins = getElapsedMinutes(cfg, per, clk);
      const gPct = getGamePct(cfg, per, clk);
      const scoreMargin = Math.abs(aS - hS);

      let signals = [];
      let has3ptFragile = false, hasStar = false;
      let starCoilTeams = {};

      // ======== 3PT FRAGILE ========
      const check3pt = (pn, an, mn, score, oppScore, opp3M, teamAbbr, oppAbbr, lead) => {
        const isHot = cfg.hotCheck(pn, an);
        if (!isHot) return null;
        const dur = analyzeScoringDurability(cfg, score, mn, oppScore);
        if (!dur.fragile) return null;
        if (lead < 3 || lead > cfg.fragileMaxMargin) return null;
        const _gMinsNow = gMins || 1;
        const oppNon3Pts = oppScore - (parseInt(opp3M) || 0) * 3;
        const oppNon3Ppm = oppNon3Pts / _gMinsNow;
        const noEngine = oppNon3Ppm < cfg.engineThreshold && _gMinsNow >= 10;
        return {
          type: '3ptFragile',
          text: `${teamAbbr} 3PT FRAGILE: ${pn.toFixed(0)}% on ${an} att, ${dur.pct3.toFixed(0)}% 3PT-dependent, lead ${lead}pts. ${noEngine ? 'Weak opp engine.' : 'Opp has engine.'}`,
          strong: !noEngine,
          teamAbbr, oppAbbr, lead, pct: pn, att: an, fragile: dur.pct3, oppEngine: !noEngine
        };
      };

      const awayLead = aS - hS;
      const homeLead = hS - aS;

      const aFragile = check3pt(a3P, a3A, a3M, aS, hS, h3M, aA, hA, awayLead);
      if (aFragile) { signals.push(aFragile); has3ptFragile = true; }

      const hFragile = check3pt(h3P, h3A, h3M, hS, aS, a3M, hA, aA, homeLead);
      if (hFragile) { signals.push(hFragile); has3ptFragile = true; }

      // ======== STAR COIL ========
      [...aLeaders, ...hLeaders].forEach(leader => {
        const star = matchStar(cfg, leader.name, leader.team);
        if (!star) return;
        const exp = getExpectedByTime(cfg, star.ppg, gMins);
        const pr = exp > 0 ? leader.pts / exp : 1;
        const inWindow = isNCAA ? cfg.coilWindow(gMins) : cfg.coilWindow(gMins, per);
        if (pr >= 0.65 || !inWindow || scoreMargin > cfg.coilMaxMargin) return;

        const side = leader.team === aA ? 'away' : 'home';
        const teamScore = side === 'away' ? aS : hS;
        const oppScore = side === 'away' ? hS : aS;
        const cast = analyzeSupportingCast(cfg, leader.pts, teamScore, oppScore, star.ppg, gMins);
        const trailing = (side === 'away' && aS < hS) || (side === 'home' && hS < aS);
        const dmg = analyzeDamageLocked(modeState, gid, side, gMins);
        const damageLocked = trailing && dmg.locked;

        let coilTier;
        if (damageLocked) coilTier = 'locked';
        else if (cast.strong) coilTier = 'elite';
        else if (cast.moderate) coilTier = 'standard';
        else coilTier = 'weak';

        if (coilTier === 'elite' || coilTier === 'standard') {
          hasStar = true;
          starCoilTeams[leader.team] = { name: leader.name, coilTier, cast, damageLocked };
          signals.push({
            type: 'star',
            text: `${leader.name} ${leader.pts}pts (exp ~${exp.toFixed(0)}, ${(pr * 100).toFixed(0)}% pace). Cast gap: ${cast.castGap}. ${coilTier.toUpperCase()}.${cast.regressionFlips ? ' Regression flips!' : ''}`,
            strong: true, teamAbbr: leader.team, coilTier, castGap: cast.castGap
          });
        } else if (coilTier === 'locked') {
          starCoilTeams[leader.team] = { name: leader.name, coilTier, cast, damageLocked };
          signals.push({ type: 'star', text: `${leader.name} LOCKED — deficit baked in`, strong: false, teamAbbr: leader.team, coilTier });
        }
      });

      // ======== SOFT COMBINED ========
      let soft3pt = false, softStar = false;
      if (!has3ptFragile || !hasStar) {
        if (!has3ptFragile) {
          const checkSoft3 = (pn, an, mn, score, oppScore, lead) => {
            if (!cfg.softHotCheck(pn, an)) return false;
            if (lead < 2 || lead > cfg.softMaxLd || score < cfg.softMinScore) return false;
            const dur = analyzeScoringDurability(cfg, score, mn, oppScore);
            return dur.pct3 >= cfg.softFragilePct;
          };
          if (checkSoft3(a3P, a3A, a3M, aS, hS, awayLead)) soft3pt = true;
          if (checkSoft3(h3P, h3A, h3M, hS, aS, homeLead)) soft3pt = true;
        } else { soft3pt = true; }

        if (!hasStar) {
          [...aLeaders, ...hLeaders].forEach(leader => {
            const star = matchStar(cfg, leader.name, leader.team);
            if (!star) return;
            const exp = getExpectedByTime(cfg, star.ppg, gMins);
            const pr = exp > 0 ? leader.pts / exp : 1;
            const inWindow = isNCAA ? cfg.softStarWindow(gMins) : cfg.softStarWindow(gMins, per);
            if (pr >= cfg.softStarPace || !inWindow || scoreMargin > cfg.softStarMargin) return;
            const side = leader.team === aA ? 'away' : 'home';
            const teamScore = side === 'away' ? aS : hS;
            const oppScore = side === 'away' ? hS : aS;
            const cast = analyzeSupportingCast(cfg, leader.pts, teamScore, oppScore, star.ppg, gMins);
            const trailing = (side === 'away' && aS < hS) || (side === 'home' && hS < aS);
            const dmg = analyzeDamageLocked(modeState, gid, side, gMins);
            const damageLocked = trailing && dmg.locked;
            let coilTier;
            if (damageLocked) coilTier = 'locked';
            else if (cast.strong) coilTier = 'elite';
            else if (cast.moderate) coilTier = 'standard';
            else coilTier = 'weak';
            const ok = cfg.softCastAcceptWeak ? coilTier !== 'locked' : (coilTier !== 'weak' && coilTier !== 'locked');
            if (ok) {
              softStar = true;
              if (!starCoilTeams[leader.team]) {
                starCoilTeams[leader.team] = { name: leader.name, coilTier, cast, damageLocked };
              }
            }
          });
        } else { softStar = true; }
      }

      const isCombined = (has3ptFragile && hasStar) || (soft3pt && softStar && !(has3ptFragile && hasStar));
      const signalCount = [has3ptFragile || soft3pt, hasStar || softStar].filter(Boolean).length;

      if (signalCount === 0) continue;

      // ======== BET SIDE ========
      let awayFade = 0, homeFade = 0;
      if (aFragile?.strong) awayFade++;
      if (hFragile?.strong) homeFade++;

      const aStarCoil = starCoilTeams[aA];
      const hStarCoil = starCoilTeams[hA];
      if (aStarCoil?.coilTier === 'elite') homeFade += 1.5;
      else if (aStarCoil?.coilTier === 'standard') homeFade += 1;
      else if (aStarCoil?.coilTier === 'locked') awayFade += 1;
      if (hStarCoil?.coilTier === 'elite') awayFade += 1.5;
      else if (hStarCoil?.coilTier === 'standard') awayFade += 1;
      else if (hStarCoil?.coilTier === 'locked') homeFade += 1;

      // Home Court Booster (NCAA only)
      let homeCourtEdge = false;
      if (isNCAA && awayFade > 0) {
        awayFade += cfg.homeCourtBoost;
        homeCourtEdge = true;
      }

      let betTeam, fadeTeam;
      if (awayFade > homeFade) { betTeam = hA; fadeTeam = aA; }
      else if (homeFade > awayFade) { betTeam = aA; fadeTeam = hA; }
      else if (awayFade > 0) { betTeam = hA; fadeTeam = aA; }
      else { betTeam = aS < hS ? aA : hA; fadeTeam = aS < hS ? hA : aA; }

      // ======== KELLY + ODDS ========
      const odds = matchOdds(modeState, aA, hA, aFull, hFull);
      const betML = odds ? (betTeam === aA ? odds.awayML : odds.homeML) : -110;
      const impliedP = betML < 0 ? Math.abs(betML) / (Math.abs(betML) + 100) : 100 / (betML + 100);
      const kelly = kellySize(impliedP, betML, signalCount);
      const rec = getRecommendation(cfg, aS, hS, per, clk, 2);

      // ======== RECORD SIGNAL ========
      const sigKey = `${gid}_${betTeam}_${cfg.mode}_${new Date().toISOString().slice(0, 13)}`;
      if (signalLog.find(s => s.key === sigKey)) continue;

      const entry = {
        key: sigKey,
        eventId: gid,
        game: gLabel,
        gameFullAway: aFull,
        gameFullHome: hFull,
        awayScore: aS,
        homeScore: hS,
        period: per,
        clock: clk,
        periodLabel: periodLabel(cfg, per),
        betTeam,
        betTeamFull: betTeam === aA ? aFull : hFull,
        fadeTeam,
        fadeTeamFull: fadeTeam === aA ? aFull : hFull,
        signals: signals.map(s => ({ type: s.type, text: s.text, strong: s.strong })),
        signalTypes: [...new Set(signals.map(s => s.type))],
        signalCount,
        isCombined,
        homeCourtEdge,
        recType: rec.type,
        recMargin: rec.margin,
        recMinRemaining: rec.minRemaining,
        marketOdds: betML,
        hasLiveOdds: !!odds,
        impliedP: Math.round(impliedP * 1000) / 10,
        kellyPct: kelly.fStar,
        kellyBet: kelly.bet,
        estWinProb: kelly.p,
        estEdge: kelly.edge,
        timestamp: Date.now(),
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        mode: cfg.mode,
        finalAwayScore: null,
        finalHomeScore: null,
        gameCompleted: false,
        mlResult: null,
        atsPayout: null
      };

      signalLog.push(entry);
      newSignals++;

      const sigTypes = entry.signalTypes.join(' + ');
      const combined = isCombined ? ' [COMBINED]' : '';
      const hc = homeCourtEdge ? ' [HOME COURT]' : '';
      log(`  [${cfg.league}] SIGNAL: ${gLabel} ${aS}-${hS} ${periodLabel(cfg, per)} ${clk} | BET ${betTeam} ${rec.type} @ ${betML} | Kelly: $${kelly.bet} (${kelly.fStar}%) | ${sigTypes}${combined}${hc}`);
    }

    if (newSignals > 0) {
      saveState();
      log(`[${cfg.league}] ${newSignals} new signal(s) recorded. Total across all modes: ${signalLog.length}`);
    }

    await resolveCompletedGames(cfg, events);

  } catch(e) {
    log(`[${cfg.league}] Error: ${e.message}`);
  }
}

// === RESOLVE COMPLETED GAMES ===
async function resolveCompletedGames(cfg, events) {
  const pending = signalLog.filter(s => !s.gameCompleted && s.mode === cfg.mode);
  if (pending.length === 0) return;

  const completed = events.filter(e => e.status?.type?.state === 'post');
  let resolved = 0;
  for (const sig of pending) {
    const game = completed.find(e => e.id === sig.eventId);
    if (!game) continue;
    const comp = game.competitions?.[0];
    if (!comp) continue;
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    if (!away || !home) continue;
    const fAS = parseInt(away.score) || 0;
    const fHS = parseInt(home.score) || 0;
    sig.finalAwayScore = fAS;
    sig.finalHomeScore = fHS;
    sig.gameCompleted = true;

    const betWon = (sig.betTeam === (away.team?.abbreviation || '') && fAS > fHS) ||
                   (sig.betTeam === (home.team?.abbreviation || '') && fHS > fAS);
    sig.mlResult = betWon ? 'WIN' : 'LOSS';

    if (betWon) {
      sig.mlPayout = sig.marketOdds > 0 ? sig.kellyBet * (sig.marketOdds / 100) : sig.kellyBet * (100 / Math.abs(sig.marketOdds));
    } else {
      sig.mlPayout = -sig.kellyBet;
    }
    resolved++;
    log(`  [${cfg.league}] RESOLVED: ${sig.game} -> ${fAS}-${fHS} | ${sig.betTeam} ${sig.mlResult} | P&L: ${sig.mlPayout > 0 ? '+' : ''}$${sig.mlPayout.toFixed(0)}`);
  }
  if (resolved > 0) saveState();
}

// === HTTP SERVER ===
function startHTTPServer() {
  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  };

  const server = http.createServer((req, res) => {
    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(DATA_DIR, urlPath);
    // Prevent directory traversal
    if (!filePath.startsWith(DATA_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404); res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  server.listen(HTTP_PORT, () => {
    log(`HTTP server running at http://localhost:${HTTP_PORT}`);
    log(`Open http://localhost:${HTTP_PORT} in your browser to view Alpha Hunter`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`Port ${HTTP_PORT} in use — trying ${HTTP_PORT + 1}...`);
      server.listen(HTTP_PORT + 1, () => {
        log(`HTTP server running at http://localhost:${HTTP_PORT + 1}`);
      });
    } else {
      log(`HTTP server error: ${e.message}`);
    }
  });
}

// === LOGGING ===
function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

// === SCAN ONE MODE ===
async function scanMode(mode) {
  const cfg = getCFG(mode);
  await fetchOdds(cfg);
  await detectSignals(cfg);
}

// === MAIN ===
async function main() {
  const modeLabel = MODES_TO_RUN.map(m => m.toUpperCase()).join(' + ');
  log(`=== ALPHA HUNTER ENGINE — ${modeLabel} MODE ===`);
  log(`Refresh: every ${REFRESH_INTERVAL / 1000}s per mode`);
  log(`Signals file: ${SIGNALS_FILE}`);

  loadState();
  log(`Loaded ${signalLog.length} existing signals`);

  // Start HTTP server
  startHTTPServer();

  // Build star DBs for active modes
  for (const mode of MODES_TO_RUN) {
    const cfg = getCFG(mode);
    await fetchOdds(cfg);
    await buildStarDB(cfg);
  }

  // Initial scan of all modes
  for (const mode of MODES_TO_RUN) {
    await scanMode(mode);
  }

  // Stagger scans: if running both, offset them by 15 seconds
  if (MODES_TO_RUN.length === 2) {
    // NBA scans at 0s, 30s, 60s, ...
    setInterval(async () => { await scanMode('nba'); }, REFRESH_INTERVAL);
    // NCAA scans at 15s, 45s, 75s, ... (15 second offset)
    setTimeout(() => {
      setInterval(async () => { await scanMode('ncaab'); }, REFRESH_INTERVAL);
    }, REFRESH_INTERVAL / 2);
  } else {
    setInterval(async () => { await scanMode(MODES_TO_RUN[0]); }, REFRESH_INTERVAL);
  }

  // Rebuild star DB every 12 hours
  setInterval(async () => {
    log('Refreshing star databases...');
    for (const mode of MODES_TO_RUN) {
      if (mode === 'ncaab') {
        starDBs.ncaab = [];
        await buildStarDB(getCFG('ncaab'));
      }
    }
  }, 12 * 60 * 60 * 1000);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
