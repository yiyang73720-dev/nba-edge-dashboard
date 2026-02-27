#!/usr/bin/env node
// ============================================================
// ALPHA HUNTER — EDGE BACKTEST + ML DISCOVERY
//
// Phase 1: Backtest existing 3PT Fragile & Star Coil edges
//          across 2 seasons of real NBA data
// Phase 2: Collect ALL game-state features at every checkpoint,
//          then run logistic regression / decision tree to find
//          which feature combinations actually predict wins
//
// Usage: node backtest-edge-discovery.js
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.dirname(process.argv[1] || __filename);
const CACHE_FILE = path.join(DATA_DIR, 'backtest-cache.json');
const RESULTS_FILE = path.join(DATA_DIR, 'backtest-results.json');
const ML_DATA_FILE = path.join(DATA_DIR, 'ml-features.json');

// NBA Stars (both seasons)
const NBA_STARS = [
  // 2025-26
  {name:'Luka Doncic',team:'LAL',ppg:32.5},{name:'Shai Gilgeous-Alexander',team:'OKC',ppg:31.8},
  {name:'Anthony Edwards',team:'MIN',ppg:29.6},{name:'Jaylen Brown',team:'BOS',ppg:29.2},
  {name:'Tyrese Maxey',team:'PHI',ppg:29.1},{name:'Nikola Jokic',team:'DEN',ppg:28.8},
  {name:'Donovan Mitchell',team:'CLE',ppg:28.5},{name:'Kawhi Leonard',team:'LAC',ppg:28.0},
  {name:'Lauri Markkanen',team:'UTA',ppg:26.7},{name:'Jalen Brunson',team:'NYK',ppg:26.7},
  {name:'Kevin Durant',team:'HOU',ppg:25.9},{name:'Jamal Murray',team:'DEN',ppg:25.5},
  {name:'Cade Cunningham',team:'DET',ppg:25.3},{name:'Devin Booker',team:'PHX',ppg:24.7},
  {name:'James Harden',team:'LAC',ppg:24.5},{name:'Victor Wembanyama',team:'SAS',ppg:24.2},
  {name:'Pascal Siakam',team:'IND',ppg:23.9},{name:'Jalen Johnson',team:'ATL',ppg:23.0},
  {name:'Norman Powell',team:'MIA',ppg:22.9},{name:'Julius Randle',team:'MIN',ppg:21.9},
  {name:'Zion Williamson',team:'NOP',ppg:21.8},
  // 2024-25
  {name:'Jayson Tatum',team:'BOS',ppg:27.0},{name:'LeBron James',team:'LAL',ppg:25.7},
  {name:'Giannis Antetokounmpo',team:'MIL',ppg:31.1},{name:'Joel Embiid',team:'PHI',ppg:33.0},
  {name:'Stephen Curry',team:'GS',ppg:26.4},{name:'Damian Lillard',team:'MIL',ppg:24.3},
  {name:'De\'Aaron Fox',team:'SAC',ppg:26.6},{name:'Trae Young',team:'ATL',ppg:25.7},
  {name:'DeMar DeRozan',team:'SAC',ppg:24.0},{name:'Brandon Ingram',team:'NOP',ppg:24.5},
  {name:'Karl-Anthony Towns',team:'NYK',ppg:25.0},{name:'Scottie Barnes',team:'TOR',ppg:21.5},
  {name:'Paolo Banchero',team:'ORL',ppg:22.6},{name:'Kyrie Irving',team:'DAL',ppg:24.0},
  {name:'Anthony Davis',team:'LAL',ppg:24.7},{name:'Domantas Sabonis',team:'SAC',ppg:21.0},
  // 2023-24
  {name:'Luka Doncic',team:'DAL',ppg:33.9},{name:'Shai Gilgeous-Alexander',team:'OKC',ppg:30.1},
  {name:'Giannis Antetokounmpo',team:'MIL',ppg:30.4},{name:'Kevin Durant',team:'PHX',ppg:27.1},
  {name:'Jayson Tatum',team:'BOS',ppg:26.9},{name:'LeBron James',team:'LAL',ppg:25.7},
  {name:'Devin Booker',team:'PHX',ppg:27.1},{name:'Anthony Edwards',team:'MIN',ppg:25.9},
  {name:'Donovan Mitchell',team:'CLE',ppg:26.6},{name:'Stephen Curry',team:'GS',ppg:26.4},
  {name:'De\'Aaron Fox',team:'SAC',ppg:26.6},{name:'Jalen Brunson',team:'NYK',ppg:28.7},
  {name:'Tyrese Haliburton',team:'IND',ppg:20.1},{name:'Anthony Davis',team:'LAL',ppg:24.7},
  {name:'Trae Young',team:'ATL',ppg:25.7},{name:'Damian Lillard',team:'MIL',ppg:24.3},
];

// ESPN → standard abbreviation normalization
const ABBR_MAP = { 'GS': 'GS', 'GSW': 'GS', 'UTAH': 'UTA', 'NOP': 'NO', 'NOR': 'NO', 'PHO': 'PHX',
  'BKN': 'BKN', 'BRK': 'BKN', 'SAS': 'SA', 'NYK': 'NY', 'WSH': 'WAS', 'WAS': 'WAS' };
function normAbbr(a) { return ABBR_MAP[a] || a; }

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dateRange(start, end) {
  const dates = [];
  const c = new Date(start + 'T12:00:00'), e = new Date(end + 'T12:00:00');
  while (c <= e) {
    dates.push(`${c.getFullYear()}${String(c.getMonth()+1).padStart(2,'0')}${String(c.getDate()).padStart(2,'0')}`);
    c.setDate(c.getDate() + 1);
  }
  return dates;
}

// ===== DATA COLLECTION =====
async function collectData() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}

  const baseUrl = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
  const seasons = [
    { start: '2024-10-22', end: '2026-02-27' },
    { start: '2023-10-24', end: '2024-04-14' },
  ];

  let totalGames = Object.keys(cache).filter(k => k.startsWith('game_')).length;
  let newFetches = 0;

  for (const season of seasons) {
    const dates = dateRange(season.start, season.end);
    log(`Checking ${dates.length} days (${season.start} to ${season.end}), ${totalGames} games cached so far`);

    for (let di = 0; di < dates.length; di++) {
      const ds = dates[di];
      if (cache[`date_${ds}`]?.complete) continue;

      let events;
      try {
        const resp = await fetch(`${baseUrl}scoreboard?dates=${ds}`);
        const data = await resp.json();
        events = (data.events || []).filter(ev => ev.status?.type?.state === 'post');
      } catch(e) { continue; }

      if (events.length === 0) { cache[`date_${ds}`] = { complete: true }; continue; }

      for (const ev of events) {
        const gid = ev.id;
        if (cache[`game_${gid}`]) continue;

        await sleep(400);
        try {
          const resp = await fetch(`${baseUrl}summary?event=${gid}`);
          const summData = await resp.json();
          const gd = extractGame(summData, ev);
          if (gd) {
            cache[`game_${gid}`] = gd;
            newFetches++;
            totalGames++;
            if (newFetches % 10 === 0) log(`  ${totalGames} games (${newFetches} new) — last: ${ev.shortName || gid}`);
          }
        } catch(e) { log(`  Error fetching ${gid}: ${e.message}`); }

        if (newFetches % 50 === 0 && newFetches > 0) {
          fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
        }
      }
      cache[`date_${ds}`] = { complete: true };

      if (di % 10 === 0 && di > 0) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
        log(`  Day ${di}/${dates.length}, ${totalGames} games, ${newFetches} new`);
      }
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  log(`Collection done: ${totalGames} total games, ${newFetches} new`);
  return cache;
}

function extractGame(summData, event) {
  const competitors = summData?.header?.competitions?.[0]?.competitors || [];
  if (competitors.length < 2) return null;

  let away = {}, home = {};
  for (const c of competitors) {
    const obj = {
      abbr: c.team?.abbreviation || '', name: c.team?.displayName || '',
      id: String(c.team?.id || ''), score: parseInt(c.score) || 0,
      winPct: null,
      linescores: (c.linescores || []).map(ls => parseInt(ls.displayValue) || 0),
    };
    for (const r of (c.records || [])) {
      if (r.type === 'total' && r.summary) {
        const [w, l] = r.summary.split('-').map(Number);
        if (!isNaN(w) && !isNaN(l) && (w+l) > 0) obj.winPct = w / (w + l);
      }
    }
    if (c.homeAway === 'away') away = obj; else home = obj;
  }
  if (!away.abbr || !home.abbr) return null;

  // Athlete ID → name + team map (from boxscore — participants lack displayName)
  const athInfo = {};
  for (const entry of (summData?.boxscore?.players || [])) {
    const tid = String(entry.team?.id || '');
    const tabbr = entry.team?.abbreviation || '';
    for (const stat of (entry.statistics || [])) {
      for (const a of (stat.athletes || [])) {
        const id = String(a.athlete?.id || '');
        if (id) athInfo[id] = { teamId: tid, teamAbbr: tabbr, name: a.athlete?.displayName || '' };
      }
    }
  }

  // Parse plays
  const plays = [...(summData?.plays || [])].sort((a, b) => {
    if (a.sequenceNumber != null && b.sequenceNumber != null) return Number(a.sequenceNumber) - Number(b.sequenceNumber);
    const pa = a.period?.number || 0, pb = b.period?.number || 0;
    if (pa !== pb) return pa - pb;
    const pClk = dv => { if (!dv) return 0; const p = dv.split(':'); return p.length === 2 ? parseInt(p[0]) * 60 + parseFloat(p[1]) : parseFloat(dv) || 0; };
    return pClk(b.clock?.displayValue) - pClk(a.clock?.displayValue);
  });

  let aS = 0, hS = 0, a3M = 0, a3A = 0, h3M = 0, h3A = 0;
  let aFTM = 0, aFTA = 0, hFTM = 0, hFTA = 0;
  let aFGM = 0, aFGA = 0, hFGM = 0, hFGA = 0;
  const pPts = {};
  const checkpoints = [];
  let lastCPE = -Infinity;

  for (const play of plays) {
    const per = play.period?.number || 1;
    const clkD = play.clock?.displayValue || '0:00';
    const cp = clkD.split(':');
    const clkSec = cp.length === 2 ? parseInt(cp[0]) * 60 + parseFloat(cp[1]) : parseFloat(clkD) || 0;
    const elapsed = (per - 1) * 12 + (12 - clkSec / 60);
    const ptid = String(play.team?.id || '');
    const isA = ptid === away.id, isH = ptid === home.id;
    const sv = play.scoreValue || 0;
    const sc = play.scoringPlay === true;
    const playText = (play.text || '').toLowerCase();
    const isFT = playText.includes('free throw');
    const isMake = playText.includes('makes');
    const isMiss = playText.includes('misses');
    const isShot = isMake || isMiss;
    const is3pt = playText.includes('three point');

    // Score tracking
    if (play.awayScore != null && play.homeScore != null) { aS = Number(play.awayScore); hS = Number(play.homeScore); }
    else if (sc && sv > 0) { if (isA) aS += sv; else if (isH) hS += sv; }

    // FG tracking (uses play.text to detect makes/misses, excludes FTs)
    if (isShot && !isFT && (isA || isH)) {
      if (isA) { aFGA++; if (isMake) aFGM++; }
      else { hFGA++; if (isMake) hFGM++; }
    }

    // 3PT tracking
    if (isShot && is3pt && !isFT && (isA || isH)) {
      if (isA) { a3A++; if (isMake) a3M++; }
      else { h3A++; if (isMake) h3M++; }
    }

    // FT tracking
    if (isShot && isFT && (isA || isH)) {
      if (isA) { aFTA++; if (isMake) aFTM++; }
      else { hFTA++; if (isMake) hFTM++; }
    }

    // Player points (use athInfo for name lookup since participants lack displayName)
    if (sc && sv > 0) {
      for (const p of (play.participants || [])) {
        const aid = String(p.athlete?.id || p.id || '');
        if (!aid) continue;
        const info = athInfo[aid];
        const pTeamAbbr = info ? info.teamAbbr : (ptid === away.id ? away.abbr : home.abbr);
        const pName = info ? info.name : (p.athlete?.displayName || '');
        if (!pPts[aid]) pPts[aid] = { name: pName, team: pTeamAbbr, pts: 0 };
        pPts[aid].pts += sv;
        break;
      }
    }

    // Checkpoint every ~2 game-minutes from 6 minutes in
    if (elapsed >= 6 && elapsed - lastCPE >= 2 && per <= 4) {
      const leaders = (abbr) => Object.values(pPts).filter(p => p.team === abbr).sort((a,b) => b.pts - a.pts).slice(0,5).map(p => ({name:p.name,team:p.team,pts:p.pts}));
      checkpoints.push({
        per, clk: clkD, elapsed: Math.round(elapsed * 10) / 10,
        aS, hS, a3M, a3A, h3M, h3A, aFTM, aFTA, hFTM, hFTA,
        aFGM, aFGA, hFGM, hFGA,
        aLead: leaders(away.abbr), hLead: leaders(home.abbr),
      });
      lastCPE = elapsed;
    }
  }

  return { away, home, fA: away.score, fH: home.score, date: event?.date || '', cps: checkpoints };
}

// ===== PHASE 1: BACKTEST EXISTING EDGES =====
function backtestExistingEdges(cache) {
  const games = Object.keys(cache).filter(k => k.startsWith('game_')).map(k => cache[k]).filter(g => g?.cps?.length > 0);
  log(`\nPHASE 1: Backtesting 3PT Fragile + Star Coil on ${games.length} games...`);

  const results = {
    '3pt_fragile': { signals: [], name: '3PT Fragile (50%+ on 12+ att, fragile lead, 3-15 margin)' },
    'star_coil': { signals: [], name: 'Star Coil (<65% pace, Q2-Q3, margin <=15)' },
    'combined': { signals: [], name: 'Combined (3PT Fragile + Star Coil same game)' },
  };

  for (const g of games) {
    const { away, home, fA, fH, cps } = g;
    const signaled = new Set();

    for (const cp of cps) {
      const { per, elapsed, aS, hS, a3M, a3A, h3M, h3A, aLead, hLead } = cp;
      const margin = Math.abs(aS - hS);
      const gMins = elapsed || 1;
      let has3pt = false, hasStar = false, betSide3pt = null, betSideStar = null;

      // --- 3PT FRAGILE ---
      const check3ptSide = (pctN, attN, madeN, score, oppScore, lead, side) => {
        const pct = attN > 0 ? (madeN / attN * 100) : 0;
        const isHot = (pct >= 50 && attN >= 12) || (pct >= 55 && attN >= 8);
        if (!isHot) return null;
        const pts3 = madeN * 3;
        const pct3dep = score > 0 ? (pts3 / score * 100) : 0;
        if (pct3dep < 42 || score < 20 || lead < 3 || lead > 15) return null;
        // Opponent paint check (non-3pt % >= 58%)
        const oppSide = side === 'away' ? 'home' : 'away';
        return { side: oppSide, pct, att: attN, pct3dep, lead }; // bet AGAINST the fragile team
      };

      const awayLead = aS - hS, homeLead = hS - aS;
      const aFrag = check3ptSide(0, a3A, a3M, aS, hS, awayLead, 'away');
      const hFrag = check3ptSide(0, h3A, h3M, hS, aS, homeLead, 'home');

      if (aFrag) { has3pt = true; betSide3pt = aFrag.side; }
      if (hFrag) { has3pt = true; betSide3pt = hFrag.side; }

      // --- STAR COIL ---
      if (per >= 2 && per <= 3 && margin <= 15) {
        const checkStarSide = (leaders, teamAbbr, teamScore, oppScore, side) => {
          for (const ldr of leaders) {
            if (!ldr.name) continue;
            const lNorm = normAbbr(ldr.team);
            const star = NBA_STARS.find(s => {
              const sLast = s.name.split(' ').pop().toLowerCase();
              const lLast = ldr.name.split(' ').pop().toLowerCase();
              return sLast === lLast && normAbbr(s.team) === lNorm;
            });
            if (!star) continue;
            const exp = star.ppg * (gMins / 48);
            const pace = exp > 0 ? ldr.pts / exp : 1;
            if (pace >= 0.65) continue;
            // Cast analysis
            const castScore = teamScore - ldr.pts;
            const castGap = castScore - oppScore;
            if (castGap >= -15) { // elite or standard
              return { side, starName: ldr.name, pace: Math.round(pace * 100), castGap };
            }
          }
          return null;
        };

        const aCoil = checkStarSide(aLead, away.abbr, aS, hS, 'away');
        const hCoil = checkStarSide(hLead, home.abbr, hS, aS, 'home');
        if (aCoil) { hasStar = true; betSideStar = aCoil.side; }
        if (hCoil) { hasStar = true; betSideStar = hCoil.side; }
      }

      // Record signals
      const recordSig = (key, side) => {
        const k = `${key}_${side}`;
        if (signaled.has(k)) return;
        signaled.add(k);
        const betAway = side === 'away';
        const won = betAway ? fA > fH : fH > fA;
        results[key].signals.push({
          game: `${away.abbr}@${home.abbr}`, betSide: side,
          per, elapsed: Math.round(elapsed), score: `${aS}-${hS}`,
          final: `${fA}-${fH}`, result: won ? 'W' : 'L'
        });
      };

      if (has3pt && betSide3pt) recordSig('3pt_fragile', betSide3pt);
      if (hasStar && betSideStar) recordSig('star_coil', betSideStar);
      if (has3pt && hasStar) {
        // Combined: use the side both agree on, or 3pt side
        const combinedSide = betSide3pt === betSideStar ? betSide3pt : (betSide3pt || betSideStar);
        if (combinedSide) recordSig('combined', combinedSide);
      }
    }
  }

  return results;
}

// ===== PHASE 2: ML FEATURE EXTRACTION =====
function extractMLFeatures(cache) {
  const games = Object.keys(cache).filter(k => k.startsWith('game_')).map(k => cache[k]).filter(g => g?.cps?.length > 0);
  log(`\nPHASE 2: Extracting ML features from ${games.length} games...`);

  const samples = [];

  for (const g of games) {
    const { away, home, fA, fH, cps } = g;
    const sampled = new Set();

    for (const cp of cps) {
      const { per, elapsed, aS, hS, a3M, a3A, h3M, h3A, aFTM, aFTA, hFTM, hFTA,
              aFGM, aFGA, hFGM, hFGA, aLead, hLead } = cp;
      if (per > 3) continue; // only Q1-Q3 for actionable signals
      if (aS === hS) continue; // skip ties

      const gMins = elapsed || 1;
      const margin = Math.abs(aS - hS);
      const trailingIsAway = aS < hS;
      const trailingSide = trailingIsAway ? 'away' : 'home';

      // Only sample once per trailing side per game
      const sk = `${trailingSide}_${per}`;
      if (sampled.has(sk)) continue;
      sampled.add(sk);

      // Outcome: did the trailing team win?
      const trailingWon = trailingIsAway ? fA > fH : fH > fA;

      // ===== FEATURES =====
      const trailingScore = trailingIsAway ? aS : hS;
      const leadingScore = trailingIsAway ? hS : aS;

      // Win% features
      const trailingWinPct = trailingIsAway ? away.winPct : home.winPct;
      const leadingWinPct = trailingIsAway ? home.winPct : away.winPct;
      const winPctGap = (trailingWinPct !== null && leadingWinPct !== null) ? trailingWinPct - leadingWinPct : null;

      // 3PT features
      const trailing3M = trailingIsAway ? a3M : h3M;
      const trailing3A = trailingIsAway ? a3A : h3A;
      const leading3M = trailingIsAway ? h3M : a3M;
      const leading3A = trailingIsAway ? h3A : a3A;
      const trailing3Pct = trailing3A > 0 ? trailing3M / trailing3A : 0;
      const leading3Pct = leading3A > 0 ? leading3M / leading3A : 0;
      const leading3Dep = leadingScore > 0 ? (leading3M * 3) / leadingScore : 0;

      // FT features
      const trailingFTM = trailingIsAway ? aFTM : hFTM;
      const trailingFTA = trailingIsAway ? aFTA : hFTA;
      const leadingFTM = trailingIsAway ? hFTM : aFTM;
      const leadingFTA = trailingIsAway ? hFTA : aFTA;
      const trailingFTPct = trailingFTA > 0 ? trailingFTM / trailingFTA : 0;
      const leadingFTPct = leadingFTA > 0 ? leadingFTM / leadingFTA : 0;

      // FG features (overall efficiency)
      const trailingFGM = trailingIsAway ? aFGM : hFGM;
      const trailingFGA = trailingIsAway ? aFGA : hFGA;
      const leadingFGM = trailingIsAway ? hFGM : aFGM;
      const leadingFGA = trailingIsAway ? hFGA : aFGA;
      const trailingFGPct = trailingFGA > 0 ? trailingFGM / trailingFGA : 0;
      const leadingFGPct = leadingFGA > 0 ? leadingFGM / leadingFGA : 0;

      // 2PT features (derived)
      const trailing2PM = trailingFGM - trailing3M;
      const trailing2PA = trailingFGA - trailing3A;
      const leading2PM = leadingFGM - leading3M;
      const leading2PA = leadingFGA - leading3A;
      const trailing2Pct = trailing2PA > 0 ? trailing2PM / trailing2PA : 0;
      const leading2Pct = leading2PA > 0 ? leading2PM / leading2PA : 0;

      // Attempt gap (rebound proxy)
      const fgaGap = (trailingIsAway ? aFGA : hFGA) - (trailingIsAway ? hFGA : aFGA);

      // Star features
      const trailingLeaders = trailingIsAway ? aLead : hLead;
      let bestStarPace = null;
      for (const ldr of (trailingLeaders || [])) {
        if (!ldr.name) continue;
        const lNorm = normAbbr(ldr.team);
        const star = NBA_STARS.find(s => {
          const sL = s.name.split(' ').pop().toLowerCase();
          const lL = ldr.name.split(' ').pop().toLowerCase();
          return sL === lL && normAbbr(s.team) === lNorm;
        });
        if (star) {
          const exp = star.ppg * (gMins / 48);
          const pace = exp > 0 ? ldr.pts / exp : 1;
          if (bestStarPace === null || pace < bestStarPace) bestStarPace = pace;
        }
      }

      // Home/away
      const trailingIsHome = !trailingIsAway;

      // Scoring pace
      const totalPace = (aS + hS) / gMins * 48;
      const trailingPPM = trailingScore / gMins;
      const leadingPPM = leadingScore / gMins;

      // Points from free throws as % of total
      const trailingFTPtsShare = trailingScore > 0 ? trailingFTM / trailingScore : 0;
      const leadingFTPtsShare = leadingScore > 0 ? leadingFTM / leadingScore : 0;

      // Linescore momentum (if Q3)
      let leaderQ1 = null, leaderQ2 = null;
      const leadingLS = trailingIsAway ? home.linescores : away.linescores;
      if (leadingLS && leadingLS.length >= 2) {
        leaderQ1 = leadingLS[0]; leaderQ2 = leadingLS[1];
      }

      samples.push({
        // Target
        trailingWon: trailingWon ? 1 : 0,

        // Core features
        margin,
        period: per,
        elapsed: Math.round(elapsed),
        trailingIsHome: trailingIsHome ? 1 : 0,
        winPctGap: winPctGap !== null ? Math.round(winPctGap * 1000) / 1000 : null,
        trailingWinPct,
        leadingWinPct,

        // 3PT
        trailing3Pct: Math.round(trailing3Pct * 1000) / 1000,
        leading3Pct: Math.round(leading3Pct * 1000) / 1000,
        leading3Dep: Math.round(leading3Dep * 1000) / 1000,
        trailing3A, leading3A,

        // FT
        trailingFTPct: Math.round(trailingFTPct * 1000) / 1000,
        leadingFTPct: Math.round(leadingFTPct * 1000) / 1000,
        trailingFTA, leadingFTA,
        trailingFTPtsShare: Math.round(trailingFTPtsShare * 1000) / 1000,
        leadingFTPtsShare: Math.round(leadingFTPtsShare * 1000) / 1000,

        // FG overall
        trailingFGPct: Math.round(trailingFGPct * 1000) / 1000,
        leadingFGPct: Math.round(leadingFGPct * 1000) / 1000,

        // 2PT
        trailing2Pct: Math.round(trailing2Pct * 1000) / 1000,
        leading2Pct: Math.round(leading2Pct * 1000) / 1000,

        // FGA gap (rebound proxy)
        fgaGap,

        // Star
        bestStarPace: bestStarPace !== null ? Math.round(bestStarPace * 1000) / 1000 : null,

        // Pace
        totalPace: Math.round(totalPace),
        trailingPPM: Math.round(trailingPPM * 100) / 100,
        leadingPPM: Math.round(leadingPPM * 100) / 100,

        // Momentum
        leaderQ1, leaderQ2,
        leaderMomentumDrop: leaderQ1 !== null && leaderQ2 !== null ? leaderQ1 - leaderQ2 : null,

        // Meta
        game: `${away.abbr}@${home.abbr}`,
      });
    }
  }

  log(`Extracted ${samples.length} ML samples`);
  return samples;
}

// ===== PHASE 2b: SIMPLE ML — FIND FEATURE SPLITS THAT PREDICT WINS =====
function runMLAnalysis(samples) {
  log(`\nPHASE 2b: Running feature importance analysis on ${samples.length} samples...`);

  // For each numeric feature, find the best threshold split
  const features = [
    'margin', 'winPctGap', 'trailing3Pct', 'leading3Pct', 'leading3Dep',
    'trailingFTPct', 'leadingFTPct', 'trailingFTA', 'leadingFTA',
    'trailingFGPct', 'leadingFGPct', 'trailing2Pct', 'leading2Pct',
    'fgaGap', 'bestStarPace', 'totalPace', 'trailingPPM', 'leadingPPM',
    'trailingFTPtsShare', 'leadingFTPtsShare',
    'leaderMomentumDrop', 'trailingIsHome',
  ];

  const baseWinRate = samples.filter(s => s.trailingWon === 1).length / samples.length;
  log(`Baseline trailing team win rate: ${(baseWinRate * 100).toFixed(1)}%`);

  const discoveries = [];

  for (const feat of features) {
    const valid = samples.filter(s => s[feat] !== null && s[feat] !== undefined && !isNaN(s[feat]));
    if (valid.length < 100) continue;

    const values = valid.map(s => s[feat]).sort((a, b) => a - b);
    const percentiles = [10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90];

    for (const pct of percentiles) {
      const threshold = values[Math.floor(values.length * pct / 100)];

      // Test: samples ABOVE threshold
      const above = valid.filter(s => s[feat] > threshold);
      if (above.length >= 30) {
        const wr = above.filter(s => s.trailingWon === 1).length / above.length;
        if (wr > baseWinRate + 0.05 || wr < baseWinRate - 0.05) {
          discoveries.push({
            feature: feat, direction: '>', threshold,
            count: above.length, winRate: wr, lift: wr - baseWinRate
          });
        }
      }

      // Test: samples BELOW threshold
      const below = valid.filter(s => s[feat] < threshold);
      if (below.length >= 30) {
        const wr = below.filter(s => s.trailingWon === 1).length / below.length;
        if (wr > baseWinRate + 0.05 || wr < baseWinRate - 0.05) {
          discoveries.push({
            feature: feat, direction: '<', threshold,
            count: below.length, winRate: wr, lift: wr - baseWinRate
          });
        }
      }
    }
  }

  // Also test multi-feature combinations (2-feature AND conditions)
  log(`Testing 2-feature combinations...`);
  const topSingles = [...new Set(discoveries.filter(d => d.lift > 0.06).map(d => d.feature))].slice(0, 8);

  for (let i = 0; i < topSingles.length; i++) {
    for (let j = i + 1; j < topSingles.length; j++) {
      const f1 = topSingles[i], f2 = topSingles[j];
      // Get best split for each feature
      const d1 = discoveries.filter(d => d.feature === f1 && d.lift > 0.05).sort((a,b) => b.lift - a.lift)[0];
      const d2 = discoveries.filter(d => d.feature === f2 && d.lift > 0.05).sort((a,b) => b.lift - a.lift)[0];
      if (!d1 || !d2) continue;

      const combo = samples.filter(s => {
        const v1 = s[f1], v2 = s[f2];
        if (v1 === null || v2 === null) return false;
        const pass1 = d1.direction === '>' ? v1 > d1.threshold : v1 < d1.threshold;
        const pass2 = d2.direction === '>' ? v2 > d2.threshold : v2 < d2.threshold;
        return pass1 && pass2;
      });

      if (combo.length >= 20) {
        const wr = combo.filter(s => s.trailingWon === 1).length / combo.length;
        if (wr > baseWinRate + 0.08) {
          discoveries.push({
            feature: `${f1}(${d1.direction}${d1.threshold}) AND ${f2}(${d2.direction}${d2.threshold})`,
            direction: 'combo', threshold: null,
            count: combo.length, winRate: wr, lift: wr - baseWinRate
          });
        }
      }
    }
  }

  // Sort by lift * sqrt(count) — balance significance and effect size
  discoveries.sort((a, b) => (b.lift * Math.sqrt(b.count)) - (a.lift * Math.sqrt(a.count)));

  return discoveries;
}

// ===== REPORTING =====
function report(existingEdges, discoveries, baseWinRate) {
  log('\n' + '='.repeat(80));
  log('PHASE 1: EXISTING EDGE BACKTEST RESULTS');
  log('='.repeat(80));

  for (const [key, edge] of Object.entries(existingEdges)) {
    const sigs = edge.signals;
    if (sigs.length === 0) { log(`\n${edge.name}: 0 signals`); continue; }
    const wins = sigs.filter(s => s.result === 'W').length;
    const wr = wins / sigs.length * 100;
    const profit = wins * 90.91 - (sigs.length - wins) * 100;
    const roi = profit / (sigs.length * 100) * 100;
    log(`\n${edge.name}`);
    log(`  ${sigs.length} signals | ${wins}W-${sigs.length - wins}L | ${wr.toFixed(1)}% win rate`);
    log(`  Profit: $${profit.toFixed(0)} (flat $100) | ROI: ${roi.toFixed(1)}%`);

    // By period
    const byP = {};
    for (const s of sigs) { if (!byP[s.per]) byP[s.per] = {w:0,l:0}; if (s.result === 'W') byP[s.per].w++; else byP[s.per].l++; }
    log(`  By Q: ${Object.entries(byP).map(([p,v]) => `Q${p}:${v.w}W-${v.l}L(${(v.w/(v.w+v.l)*100).toFixed(0)}%)`).join(' ')}`);
  }

  log('\n' + '='.repeat(80));
  log('PHASE 2: ML-DISCOVERED FEATURES (ranked by statistical significance)');
  log(`Baseline: trailing team wins ${(baseWinRate * 100).toFixed(1)}% of the time`);
  log('='.repeat(80));

  const shown = new Set();
  let rank = 0;
  for (const d of discoveries.slice(0, 40)) {
    // Dedup similar features
    const simKey = `${d.feature}_${d.direction}`;
    if (shown.has(simKey)) continue;
    shown.add(simKey);
    rank++;

    const winPct = (d.winRate * 100).toFixed(1);
    const liftPct = (d.lift * 100).toFixed(1);
    const evPer100 = (d.winRate * 90.91 - (1 - d.winRate) * 100).toFixed(1);
    const isCombo = d.direction === 'combo';
    const profitTotal = (d.count * parseFloat(evPer100) / 100).toFixed(0);

    log(`\n#${rank}. ${d.feature} ${isCombo ? '' : d.direction + ' ' + (typeof d.threshold === 'number' ? d.threshold.toFixed(3) : d.threshold)}`);
    log(`   ${d.count} samples | Win: ${winPct}% | Lift: +${liftPct}% | EV/$100: $${evPer100} | Total P&L: $${profitTotal}`);
  }
}

// ===== MAIN =====
async function main() {
  log('=== ALPHA HUNTER: EDGE BACKTEST + ML DISCOVERY ===\n');

  const cache = await collectData();

  // Phase 1: Backtest existing edges
  const existingEdges = backtestExistingEdges(cache);

  // Phase 2: ML feature extraction + analysis
  const samples = extractMLFeatures(cache);
  fs.writeFileSync(ML_DATA_FILE, JSON.stringify(samples.slice(0, 100), null, 2)); // save sample for inspection

  const baseWinRate = samples.filter(s => s.trailingWon === 1).length / samples.length;
  const discoveries = runMLAnalysis(samples);

  // Report
  report(existingEdges, discoveries, baseWinRate);

  // Save everything
  const output = {
    existingEdges: {},
    mlDiscoveries: discoveries.slice(0, 50),
    baseWinRate,
    totalSamples: samples.length,
    totalGames: Object.keys(cache).filter(k => k.startsWith('game_')).length,
  };
  for (const [k, v] of Object.entries(existingEdges)) {
    output.existingEdges[k] = { name: v.name, count: v.signals.length, wins: v.signals.filter(s => s.result === 'W').length, winRate: v.signals.length > 0 ? v.signals.filter(s => s.result === 'W').length / v.signals.length : 0 };
  }
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));
  log(`\nResults saved to ${RESULTS_FILE}`);
  log(`ML feature samples saved to ${ML_DATA_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
