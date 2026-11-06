// Public sports feeds -> one normalized state object for the dashboard.
//
// This module runs in two places:
//   * scripts/build-snapshot.mjs (Node) writes data/snapshot.json on a GitHub
//     Actions schedule.
//   * assets/app.js (the visitor's browser) refreshes from the same feeds live.
// The NHL's own API sends no CORS headers, so its fields (goalie matchup,
// special teams, official standings) and the multi-season history lookups are
// fetched in Node only; the browser carries them over from the snapshot.
// Every request is logged in ctx.sources and every derived item names the
// source ids it rests on, so the page can cite each number.

import { etDayNumber } from './format.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports';
const NHL = 'https://api-web.nhle.com/v1';
const MLB = 'https://statsapi.mlb.com/api/v1';
const NWS = 'https://api.weather.gov';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const METEO = 'https://api.open-meteo.com/v1/forecast';

export const TEAMS = [
  { key: 'steelers', name: 'Steelers', say: 'the Steelers', full: 'Pittsburgh Steelers', league: 'NFL', sport: 'football', path: 'football/nfl', espnId: 'pit' },
  { key: 'penguins', name: 'Penguins', say: 'the Penguins', full: 'Pittsburgh Penguins', league: 'NHL', sport: 'hockey', path: 'hockey/nhl', espnId: 'pit', nhl: 'PIT' },
  { key: 'pirates', name: 'Pirates', say: 'the Pirates', full: 'Pittsburgh Pirates', league: 'MLB', sport: 'baseball', path: 'baseball/mlb', espnId: 'pit', mlbId: 134 },
  { key: 'pitt', name: 'Pitt', say: 'Pitt', full: 'Pitt Panthers', league: 'NCAAF', sport: 'football', path: 'football/college-football', espnId: '221' },
];

const DAY = 864e5;

const STATES = Object.fromEntries('AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming'
  .split('|').map((s) => [s.slice(0, 2), s.slice(3)]));

const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorms', 96: 'Thunderstorms', 99: 'Thunderstorms' };

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(typeof v === 'object' ? (v.value ?? v.displayValue) : v);
  return Number.isFinite(n) ? n : null;
};
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const statMap = (stats) => Object.fromEntries((stats || []).map((s) => [s.name, s.displayValue ?? s.value ?? s.summary]));
const meta = (t) => ({ key: t.key, name: t.name, say: t.say, full: t.full, league: t.league, sport: t.sport });

export function parseRecord(s) {
  const [w, l, x] = String(s ?? '').split('-').map((p) => Number.parseInt(p, 10));
  return Number.isFinite(w) && Number.isFinite(l) ? { w, l, x: Number.isFinite(x) ? x : 0 } : null;
}

export function createContext({ env = 'browser', userAgent = null } = {}) {
  const sources = [];
  async function get(id, label, url, { timeout = 15000 } = {}) {
    const rec = { id, label, url, at: new Date().toISOString(), ok: false, env };
    sources.push(rec);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: userAgent ? { 'User-Agent': userAgent } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      rec.ok = true;
      return body;
    } catch (err) {
      rec.error = err.name === 'AbortError' ? 'timed out' : String(err.message || err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return { env, sources, get };
}

// ---------------------------------------------------------------- ESPN

function teamRef(t, league) {
  if (!t) return null;
  const nick = t.name || t.nickname || t.shortDisplayName || t.displayName;
  const college = league === 'NCAAF';
  return {
    id: String(t.id),
    abbr: t.abbreviation || '',
    name: t.displayName || nick,
    nick,
    location: t.location || '',
    short: college ? (t.location || t.shortDisplayName || nick) : nick,
    say: college ? (t.location || t.shortDisplayName || nick) : `the ${nick}`,
    color: t.color ? `#${t.color}` : null,
  };
}

async function espnTeam(ctx, t) {
  const j = await ctx.get(`espn-team-${t.key}`, `ESPN · ${t.name} team`, `${ESPN}/${t.path}/teams/${t.espnId}`);
  const tm = j.team;
  const items = tm.record?.items || [];
  const total = items.find((i) => i.type === 'total');
  return {
    id: String(tm.id),
    color: tm.color ? `#${tm.color}` : null,
    standingSummary: tm.standingSummary || null,
    record: {
      total: total?.summary ?? null,
      home: items.find((i) => i.type === 'home')?.summary ?? null,
      road: items.find((i) => i.type === 'road')?.summary ?? null,
      stats: Object.fromEntries((total?.stats || []).map((s) => [s.name, s.value])),
    },
    nextEvent: tm.nextEvent?.[0] || null,
  };
}

function espnGames(schedule, ourId, t) {
  return (schedule.events || []).map((ev) => {
    const c = ev.competitions?.[0];
    const us = c?.competitors?.find((x) => sameId(x.team?.id ?? x.id, ourId));
    const them = c?.competitors?.find((x) => x !== us);
    if (!us || !them) return null;
    const st = c.status?.type || {};
    const done = st.completed === true;
    const pf = done ? num(us.score) : null;
    const pa = done ? num(them.score) : null;
    const detail = st.detail || st.shortDetail || '';
    const extra = /SO/.test(detail) ? 'SO' : /OT/.test(detail) ? 'OT' : null;
    let result = null;
    if (done && pf != null && pa != null) {
      result = pf > pa ? 'W' : pf < pa ? (extra && t.sport === 'hockey' ? 'OTL' : 'L') : 'T';
    }
    return {
      id: String(ev.id),
      date: ev.date,
      label: ev.week?.text || null,
      state: st.state,
      home: us.homeAway === 'home',
      neutral: !!c.neutralSite,
      venue: c.venue ? { name: c.venue.fullName, city: c.venue.address?.city || null, state: c.venue.address?.state || null, country: c.venue.address?.country || null } : null,
      opp: teamRef(them.team, t.league),
      pf, pa, result, extra,
    };
  }).filter(Boolean);
}

function rankOf(c) {
  const r = c?.curatedRank?.current ?? c?.rank;
  return r && r <= 25 ? r : null;
}

function conferenceTable(group, ourId) {
  const rows = (group.standings?.entries || []).map((e) => {
    const overall = e.stats?.find((s) => s.type === 'total' || s.name === 'overall')?.summary ?? null;
    const conf = e.stats?.find((s) => s.abbreviation === 'CONF' || s.name === 'vs. Conf.')?.summary ?? null;
    const o = parseRecord(overall);
    const c = parseRecord(conf);
    return { id: String(e.id), name: e.team, w: o?.w ?? null, l: o?.l ?? null, cw: c?.w ?? null, cl: c?.l ?? null, overall, conf, isPgh: sameId(e.id, ourId) };
  });
  const group0 = (group.header || 'Conference').replace(/^\d{4}\s+/, '').replace(/\s+Standings$/, '');
  return { group: group0, kind: 'conf', rows, rank: rows.findIndex((r) => r.isPgh) + 1 || null };
}

async function espnPreview(ctx, t, eventId, ourId) {
  const s = await ctx.get(`espn-preview-${t.key}`, `ESPN · ${t.name} game preview`, `${ESPN}/${t.path}/summary?event=${eventId}`);
  const comp = s.header?.competitions?.[0];
  if (!comp) return null;
  const us = comp.competitors.find((c) => sameId(c.team?.id ?? c.id, ourId));
  const them = comp.competitors.find((c) => c !== us);
  if (!us || !them) return null;
  const sideOf = (teamId) => (sameId(teamId, us.team.id) ? 'pgh' : 'opp');
  const split = (list, idOf, map) => {
    const out = { pgh: [], opp: [] };
    for (const x of list || []) out[sideOf(idOf(x))].push(...map(x));
    return out;
  };
  const recs = (c) => Object.fromEntries((c.record || []).map((r) => [r.type, r.summary]));
  const pred = s.predictor;
  const proj = (side) => {
    if (!pred) return null;
    const usHome = sameId(pred.homeTeam?.id, us.team.id);
    const node = (side === 'pgh') === usHome ? pred.homeTeam : pred.awayTeam;
    return num(node?.gameProjection);
  };
  const venue = s.gameInfo?.venue;
  // ESPN omits an indoor flag but only attaches a forecast to open-air games.
  const outdoor = s.gameInfo?.weather ? true : t.sport === 'hockey' ? false : null;
  return {
    id: String(eventId),
    date: comp.date,
    state: comp.status?.type?.state || 'pre',
    statusDetail: comp.status?.type?.detail || '',
    statusShort: comp.status?.type?.shortDetail || '',
    score: { pgh: num(us.score), opp: num(them.score) },
    home: us.homeAway === 'home',
    neutral: !!comp.neutralSite,
    conference: !!comp.conferenceCompetition,
    kind: t.league === 'NCAAF' && comp.conferenceCompetition ? 'Conference game' : null,
    opp: { ...teamRef(them.team, t.league), rank: rankOf(them) },
    pghRank: rankOf(us),
    records: { pgh: recs(us), opp: recs(them) },
    venue: venue ? {
      name: venue.fullName,
      city: venue.address?.city || null,
      state: venue.address?.state || null,
      country: venue.address?.country || null,
      indoor: venue.indoor ?? (outdoor == null ? null : !outdoor),
      grass: venue.grass ?? null,
    } : null,
    espnWeather: s.gameInfo?.weather ? { tempF: num(s.gameInfo.weather.temperature), gust: num(s.gameInfo.weather.gust), precip: num(s.gameInfo.weather.precipitation) } : null,
    broadcasts: [...new Set((comp.broadcasts || []).map((b) => b.media?.shortName).filter(Boolean))],
    predictor: pred ? { pgh: proj('pgh'), opp: proj('opp') } : null,
    injuries: s.injuries ? split(s.injuries, (x) => x.team?.id, (x) => (x.injuries || []).map((i) => ({
      name: i.athlete?.displayName || '',
      pos: i.athlete?.position?.abbreviation || '',
      status: i.status || '',
      detail: i.details?.type || i.type?.description || '',
      date: i.date || null,
    }))) : null,
    leaders: s.leaders ? split(s.leaders, (x) => x.team?.id, (x) => (x.leaders || []).filter((c) => c.leaders?.length).map((c) => ({
      cat: c.displayName,
      name: c.leaders[0].athlete?.displayName || '',
      value: c.leaders[0].displayValue,
    }))) : null,
    form: s.lastFiveGames ? split(s.lastFiveGames, (x) => x.team?.id, (x) => (x.events || []).map((e) => ({
      r: e.gameResult, score: e.score, opp: e.opponent?.abbreviation || '', date: e.gameDate, home: e.atVs === 'vs',
    }))) : null,
    series: s.seasonseries?.[0] ? { summary: s.seasonseries[0].summary, total: s.seasonseries[0].totalCompetitions, score: s.seasonseries[0].seriesScore } : null,
    headline: s.article?.headline ? { text: s.article.headline, url: s.article.links?.web?.href || null } : null,
    conferenceTable: s.standings?.groups?.[0] ? conferenceTable(s.standings.groups[0], us.team.id) : null,
    link: (s.header?.links || []).find((l) => l.rel?.includes('summary'))?.href || null,
    sources: [`espn-preview-${t.key}`],
  };
}

async function espnDivision(ctx, t, ourId) {
  const j = await ctx.get(`espn-standings-${t.key}`, `ESPN · ${t.league} standings`, `${ESPN_V2}/${t.path}/standings?level=3`);
  const groups = [];
  (function walk(n) {
    if (n.standings?.entries?.length) groups.push(n);
    (n.children || []).forEach(walk);
  })(j);
  const g = groups.find((x) => x.standings.entries.some((e) => sameId(e.team?.id, ourId)));
  if (!g) return null;
  let rows = g.standings.entries.map((e, i) => {
    const s = statMap(e.stats);
    return {
      i,
      id: String(e.team.id),
      abbr: e.team.abbreviation,
      name: e.team.shortDisplayName || e.team.displayName,
      w: num(s.wins), l: num(s.losses), t: num(s.ties) || 0, otl: num(s.otLosses), pts: num(s.points), gp: num(s.gamesPlayed),
      gb: s.gamesBehind ?? null,
      streak: s.streak ?? null,
      diff: s.pointDifferential ?? null,
      div: s['vs. Div.'] ?? null,
      home: s.Home ?? null,
      road: s.Road ?? null,
      l10: (s['Last Ten Games'] || '').replace(/,.*$/, '') || null,
      isPgh: sameId(e.team.id, ourId),
    };
  });
  const winPct = (r) => (r.w + r.t / 2) / Math.max(1, r.w + r.l + r.t);
  rows.sort(t.league === 'NHL'
    ? (a, b) => (b.pts - a.pts) || (a.gp - b.gp) || (a.i - b.i)
    : (a, b) => (winPct(b) - winPct(a)) || (a.i - b.i));
  rows = rows.map(({ i, ...r }) => r);
  return { group: g.name, kind: t.league.toLowerCase(), rows, rank: rows.findIndex((r) => r.isPgh) + 1, sources: [`espn-standings-${t.key}`] };
}

// ESPN's schedule, summary and standings endpoints allow browser requests; its
// team page does not, so the team page is read in Node only, for cross-checks.
async function espnCore(ctx, t) {
  const [sched, page] = await Promise.all([
    ctx.get(`espn-schedule-${t.key}`, `ESPN · ${t.name} schedule`, `${ESPN}/${t.path}/teams/${t.espnId}/schedule`),
    ctx.env === 'node' ? espnTeam(ctx, t).catch(() => null) : Promise.resolve(null),
  ]);
  const tm = sched.team || {};
  const team = { id: String(tm.id), color: tm.color ? `#${tm.color}` : null, record: tm.recordSummary || null, standingSummary: tm.standingSummary || null };
  const games = espnGames(sched, team.id, t);
  const upcoming = games.find((g) => g.state === 'in') || games.find((g) => g.state === 'pre');
  const next = upcoming ? await espnPreview(ctx, t, upcoming.id, team.id).catch(() => null) : null;
  const live = next?.state === 'in'
    ? { id: next.id, detail: next.statusShort || next.statusDetail, pgh: next.score?.pgh ?? null, opp: next.score?.opp ?? null, oppAbbr: next.opp.abbr }
    : null;
  const season = sched.requestedSeason || sched.season || {};
  return { team, page, games, next, live, season: { year: season.year, type: season.type, label: season.displayName || String(season.year ?? '') } };
}

function phaseOf(season, next) {
  if (!next) return 'offseason';
  return season.type === 3 ? 'postseason' : season.type === 1 ? 'preseason' : 'regular';
}

// ---------------------------------------------------------------- weather

async function gameWeather(ctx, key, venue, iso) {
  if (!venue || venue.indoor !== false || !venue.city) return null;
  if (venue.country && venue.country !== 'USA') return null;
  const hours = (Date.parse(iso) - Date.now()) / 36e5;
  if (hours < -4 || hours > 15 * 24) return { pending: true, hours: Math.round(hours) };
  const geo = await ctx.get(`geo-${key}`, `Open-Meteo · locate ${venue.city}`, `${GEO}?name=${encodeURIComponent(venue.city)}&count=10&language=en&format=json`);
  const stateName = STATES[venue.state] || venue.state;
  const place = (geo.results || []).find((r) => r.country_code === 'US' && (!stateName || r.admin1 === stateName));
  if (!place) return null;
  const lat = place.latitude.toFixed(4);
  const lon = place.longitude.toFixed(4);
  const kickoff = Date.parse(iso);
  if (hours <= 150) {
    try {
      const pt = await ctx.get(`nws-point-${key}`, `NWS · ${venue.city} forecast grid`, `${NWS}/points/${lat},${lon}`);
      const fc = await ctx.get(`nws-hourly-${key}`, `NWS · ${venue.city} hourly forecast`, pt.properties.forecastHourly);
      const p = fc.properties.periods.find((x) => Date.parse(x.startTime) <= kickoff && kickoff < Date.parse(x.endTime));
      if (p) {
        return {
          sourceId: `nws-hourly-${key}`, by: 'National Weather Service', longRange: false,
          tempF: p.temperature, windMph: Number.parseInt(p.windSpeed, 10) || 0, wind: `${p.windSpeed} ${p.windDirection}`.trim(),
          precip: p.probabilityOfPrecipitation?.value ?? null, text: p.shortForecast, at: p.startTime,
        };
      }
    } catch { /* fall through to the model forecast */ }
  }
  const om = await ctx.get(`meteo-${key}`, `Open-Meteo · ${venue.city} forecast`,
    `${METEO}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=16`);
  const times = om.hourly?.time || [];
  const i = times.findIndex((x) => Date.parse(`${x}Z`) + 36e5 > kickoff);
  if (i < 0) return null;
  return {
    sourceId: `meteo-${key}`, by: 'Open-Meteo (GFS/ECMWF models)', longRange: hours > 150,
    tempF: Math.round(om.hourly.temperature_2m[i]), windMph: Math.round(om.hourly.wind_speed_10m[i]), wind: `${Math.round(om.hourly.wind_speed_10m[i])} mph`,
    precip: om.hourly.precipitation_probability?.[i] ?? null, text: WMO[om.hourly.weather_code[i]] || 'Mixed', at: `${times[i]}Z`,
  };
}

// ---------------------------------------------------------------- teams

async function buildFootball(ctx, t) {
  const core = await espnCore(ctx, t);
  const standing = t.league === 'NFL'
    ? await espnDivision(ctx, t, core.team.id).catch(() => null)
    : core.next?.conferenceTable ? { ...core.next.conferenceTable, sources: [`espn-preview-${t.key}`] } : null;
  if (core.next) core.next.weather = await gameWeather(ctx, t.key, core.next.venue, core.next.date).catch(() => null);
  const rec = parseRecord(core.team.record);
  const row = standing?.rows?.find((r) => r.isPgh);
  return {
    ...meta(t),
    color: core.team.color,
    espnId: core.team.id,
    phase: phaseOf(core.season, core.next),
    seasonLabel: core.season.label,
    record: { summary: core.team.record, w: rec?.w ?? null, l: rec?.l ?? null, t: rec?.x ?? 0, home: row?.home ?? null, road: row?.road ?? null },
    espnRecord: core.page?.record?.total ?? null,
    standing,
    games: core.games,
    next: core.next,
    live: core.live,
  };
}

async function buildHockey(ctx, t) {
  const core = await espnCore(ctx, t);
  const [standing, official] = await Promise.all([
    espnDivision(ctx, t, core.team.id).catch(() => null),
    ctx.env === 'node' ? nhlOfficial(ctx, t).catch((err) => ({ error: String(err.message || err) })) : Promise.resolve(null),
  ]);
  const rec = parseRecord(core.team.record);
  const row = standing?.rows?.find((r) => r.isPgh);
  return {
    ...meta(t),
    color: core.team.color,
    espnId: core.team.id,
    phase: phaseOf(core.season, core.next),
    seasonLabel: core.season.label,
    record: {
      summary: core.team.record,
      w: rec?.w ?? null, l: rec?.l ?? null, otl: rec?.x ?? null,
      pts: row?.pts ?? null, gp: row?.gp ?? null, home: row?.home ?? null, road: row?.road ?? null,
    },
    espnRecord: core.page?.record?.total ?? null,
    standing,
    games: core.games,
    next: core.next,
    live: core.live,
    official,
  };
}

async function nhlOfficial(ctx, t) {
  const [sched, stand] = await Promise.all([
    ctx.get('nhl-schedule', 'NHL · Penguins schedule', `${NHL}/club-schedule-season/${t.nhl}/now`),
    ctx.get('nhl-standings', 'NHL · standings', `${NHL}/standings/now`),
  ]);
  const row = (stand.standings || []).find((r) => r.teamAbbrev?.default === t.nhl);
  const out = {
    standing: row ? {
      w: row.wins, l: row.losses, otl: row.otLosses, pts: row.points, gp: row.gamesPlayed, pointPctg: row.pointPctg,
      division: row.divisionName, divRank: row.divisionSequence, confRank: row.conferenceSequence, wildcardRank: row.wildcardSequence,
      streak: row.streakCode ? `${row.streakCode}${row.streakCount}` : null,
      l10: `${row.l10Wins}-${row.l10Losses}-${row.l10OtLosses}`,
    } : null,
    next: null,
  };
  const nextGame = (sched.games || []).find((g) => [2, 3].includes(g.gameType) && !['OFF', 'FINAL'].includes(g.gameState));
  if (!nextGame) return out;
  const [landing, rail] = await Promise.all([
    ctx.get('nhl-matchup', 'NHL · game matchup', `${NHL}/gamecenter/${nextGame.id}/landing`),
    ctx.get('nhl-rightrail', 'NHL · team comparison', `${NHL}/gamecenter/${nextGame.id}/right-rail`),
  ]);
  const pghHome = landing.homeTeam?.abbrev === t.nhl;
  const sides = (o) => (pghHome ? { pgh: o?.homeTeam, opp: o?.awayTeam } : { pgh: o?.awayTeam, opp: o?.homeTeam });
  const m = landing.matchup || {};
  const gc = sides(m.goalieComparison);
  const goalie = (g) => ({ name: `${g.firstName?.default ?? ''} ${g.lastName?.default ?? ''}`.trim() || g.name?.default, gp: g.gamesPlayed, record: g.record, gaa: g.gaa, svp: g.savePctg, so: g.shutouts });
  const skater = (p) => (p ? { name: `${p.firstName?.default ?? ''} ${p.lastName?.default ?? ''}`.trim() || p.name?.default, value: p.value } : null);
  const ts = sides(rail.teamSeasonStats);
  const l10 = sides(rail.last10Record);
  const coach = sides(rail.gameInfo);
  const stats = (x) => x && {
    pp: x.ppPctg, ppRank: x.ppPctgRank, pk: x.pkPctg, pkRank: x.pkPctgRank, fo: x.faceoffWinningPctg, foRank: x.faceoffWinningPctgRank,
    gf: x.goalsForPerGamePlayed, gfRank: x.goalsForPerGamePlayedRank, ga: x.goalsAgainstPerGamePlayed, gaRank: x.goalsAgainstPerGamePlayedRank,
  };
  out.next = {
    id: String(nextGame.id),
    date: nextGame.startTimeUTC,
    venueUTCOffset: landing.venueUTCOffset || null,
    venueTimezone: landing.venueTimezone || null,
    goalies: { pgh: (gc.pgh?.leaders || []).map(goalie), opp: (gc.opp?.leaders || []).map(goalie) },
    lastFive: (m.skaterComparison?.leaders || []).map((L) => ({
      cat: L.category, pgh: skater(pghHome ? L.homeLeader : L.awayLeader), opp: skater(pghHome ? L.awayLeader : L.homeLeader),
    })),
    special: { pgh: stats(ts.pgh), opp: stats(ts.opp) },
    last10: {
      pgh: l10.pgh ? { record: l10.pgh.record, streak: `${l10.pgh.streakType}${l10.pgh.streak}` } : null,
      opp: l10.opp ? { record: l10.opp.record, streak: `${l10.opp.streakType}${l10.opp.streak}` } : null,
    },
    coaches: { pgh: coach.pgh?.headCoach?.default || null, opp: coach.opp?.headCoach?.default || null },
    tv: (landing.tvBroadcasts || []).map((b) => b.network?.trim()).filter(Boolean),
  };
  return out;
}

function mlbGames(sched, teamId) {
  const byPk = new Map();
  for (const d of sched?.dates || []) {
    for (const g of d.games || []) {
      const home = sameId(g.teams?.home?.team?.id, teamId);
      const us = home ? g.teams.home : g.teams.away;
      const them = home ? g.teams.away : g.teams.home;
      const state = g.status?.detailedState || '';
      const done = ['Final', 'Game Over', 'Completed Early'].includes(state);
      const nick = them.team.teamName || them.team.name;
      byPk.set(g.gamePk, {
        id: String(g.gamePk),
        date: g.gameDate,
        day: g.officialDate,
        type: g.gameType,
        tbd: !!g.status?.startTimeTBD,
        state: done ? 'post' : 'pre',
        dropped: /Postponed|Cancelled|Suspended/.test(state),
        home,
        neutral: false,
        venue: g.venue?.name ? { name: g.venue.name } : null,
        opp: { id: String(them.team.id), abbr: them.team.abbreviation || '', name: them.team.name, nick, short: nick, say: `the ${nick}` },
        pf: done ? us.score ?? null : null,
        pa: done ? them.score ?? null : null,
        result: done ? (us.isWinner ? 'W' : them.isWinner ? 'L' : 'T') : null,
      });
    }
  }
  return [...byPk.values()].filter((g) => !g.dropped).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

const MLB_LEADERS = {
  homeRuns: ['hitting', 'HR'], battingAverage: ['hitting', 'AVG'], onBasePlusSlugging: ['hitting', 'OPS'], stolenBases: ['hitting', 'SB'],
  wins: ['pitching', 'W'], earnedRunAverage: ['pitching', 'ERA'], strikeouts: ['pitching', 'K'], saves: ['pitching', 'SV'],
};
const MLB_FIELDS = 'dates,games,gamePk,gameDate,gameType,officialDate,status,detailedState,startTimeTBD,teams,away,home,team,id,name,abbreviation,teamName,score,isWinner,venue';

async function buildBaseball(ctx, t) {
  const cal = await ctx.get('mlb-seasons', 'MLB · season calendar', `${MLB}/seasons?sportId=1`);
  const cur = cal.seasons?.[0] || {};
  const now = Date.now();
  const year = Number(cur.seasonId);
  const regStart = Date.parse(cur.regularSeasonStartDate);
  const regEnd = Date.parse(cur.regularSeasonEndDate);
  const postEnd = Date.parse(cur.postSeasonEndDate || cur.seasonEndDate || cur.regularSeasonEndDate);
  const springStart = Date.parse(cur.springStartDate || cur.preSeasonStartDate || cur.regularSeasonStartDate);
  const beforeOpener = now < regStart;
  const resultsYear = beforeOpener ? year - 1 : year;
  let phase = 'offseason';
  if (beforeOpener) phase = now >= springStart ? 'preseason' : 'offseason';
  else if (now <= regEnd + DAY) phase = 'regular';
  else if (now <= postEnd + DAY) phase = 'postseason';
  const upcomingYear = beforeOpener ? year : year + 1;

  const [standings, sched, txs, leaders, espn] = await Promise.all([
    ctx.get('mlb-standings', `MLB · ${resultsYear} NL standings`, `${MLB}/standings?leagueId=104&season=${resultsYear}&standingsTypes=regularSeason&hydrate=team,division`),
    ctx.get('mlb-schedule', `MLB · Pirates ${resultsYear} results`, `${MLB}/schedule?sportId=1&teamId=${t.mlbId}&season=${resultsYear}&gameType=R&hydrate=team&fields=${MLB_FIELDS}`),
    ctx.get('mlb-transactions', 'MLB · Pirates transactions', `${MLB}/transactions?teamId=${t.mlbId}&startDate=${ymd(now - 45 * DAY)}&endDate=${ymd(now)}`).catch(() => null),
    ctx.get('mlb-leaders', `MLB · Pirates ${resultsYear} leaders`, `${MLB}/teams/${t.mlbId}/leaders?leaderCategories=${Object.keys(MLB_LEADERS).join(',')}&season=${resultsYear}&limit=1`).catch(() => null),
    ctx.env === 'node' ? espnTeam(ctx, t).catch(() => null) : Promise.resolve(null),
  ]);
  const games = mlbGames(sched, t.mlbId);

  const div = (standings.records || []).find((r) => r.teamRecords.some((tr) => sameId(tr.team.id, t.mlbId)));
  const rows = (div?.teamRecords || []).map((tr) => ({
    id: String(tr.team.id), abbr: tr.team.abbreviation, name: tr.team.teamName || tr.team.name,
    w: tr.wins, l: tr.losses, pct: tr.winningPercentage, gb: tr.gamesBack, wcgb: tr.wildCardGamesBack,
    diff: tr.runDifferential, streak: tr.streak?.streakCode || null, rank: Number(tr.divisionRank), clinched: !!tr.clinched,
    isPgh: sameId(tr.team.id, t.mlbId),
  })).sort((a, b) => a.rank - b.rank);
  const me = rows.find((r) => r.isPgh);
  const standing = div ? { group: div.division?.nameShort || div.division?.name || 'Division', kind: 'mlb', rows, rank: me?.rank ?? null, sources: ['mlb-standings'] } : null;

  const moves = (txs?.transactions || [])
    .map((x) => ({ date: x.date || x.effectiveDate, text: x.description, type: x.typeDesc || '' }))
    .filter((m) => m.text && m.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const lead = (leaders?.teamLeaders || [])
    .filter((L) => MLB_LEADERS[L.leaderCategory]?.[0] === L.statGroup && L.leaders?.length)
    .map((L) => ({ cat: MLB_LEADERS[L.leaderCategory][1], name: L.leaders[0].person?.fullName || '', value: L.leaders[0].value }));

  let next = null;
  let live = null;
  let offseason = null;
  if (phase === 'offseason' || phase === 'preseason') {
    const upcoming = await ctx.get('mlb-next-schedule', `MLB · Pirates ${upcomingYear} schedule`, `${MLB}/schedule?sportId=1&teamId=${t.mlbId}&season=${upcomingYear}&gameType=S,R&hydrate=team&fields=${MLB_FIELDS}`).catch(() => null);
    const future = mlbGames(upcoming, t.mlbId).filter((g) => Date.parse(g.date) > now - 4 * 36e5);
    const spring = future.find((g) => g.type === 'S');
    const opener = future.find((g) => g.type === 'R');
    const pick = spring || opener;
    if (pick) {
      next = {
        id: pick.id, date: pick.date, tbd: pick.tbd, day: pick.day, state: 'pre', home: pick.home, neutral: false,
        kind: pick.type === 'S' ? 'Spring training' : 'Opening Day',
        opp: pick.opp, venue: pick.venue ? { name: pick.venue.name, indoor: null } : null,
        broadcasts: [], sources: ['mlb-next-schedule'],
      };
    }
    offseason = {
      resultsYear, upcomingYear,
      openingDay: opener ? { date: opener.date, tbd: opener.tbd, day: opener.day, home: opener.home, opp: opener.opp, venue: opener.venue } : null,
      springOpener: spring ? { date: spring.date, tbd: spring.tbd, day: spring.day, home: spring.home, opp: spring.opp, venue: spring.venue } : null,
      moves, leaders: lead,
    };
  } else {
    const core = await espnCore(ctx, t).catch(() => null);
    next = core?.next || null;
    live = core?.live || null;
  }

  return {
    ...meta(t),
    color: espn?.color || null,
    espnId: espn?.id || null,
    phase,
    seasonLabel: String(resultsYear),
    record: me ? { summary: `${me.w}-${me.l}`, w: me.w, l: me.l, t: 0, home: null, road: null } : null,
    espnRecord: espn?.record?.total || null,
    espnNext: espn?.nextEvent ? { id: espn.nextEvent.id, date: espn.nextEvent.date } : null,
    standing,
    games,
    next,
    live,
    offseason,
    leaders: lead,
  };
}

// ---------------------------------------------------------------- history (Node only)

async function buildHistory(ctx, state) {
  const years = (from, n) => Array.from({ length: n }, (_, i) => from - i);
  const pir = state.teams.pirates;
  const mlbYear = Number(pir?.seasonLabel) || new Date().getUTCFullYear();
  const out = { builtAt: new Date().toISOString() };

  const seasons = await Promise.all(years(mlbYear, 12).map((y) =>
    ctx.get(`mlb-standings-${y}`, `MLB · ${y} NL standings`, `${MLB}/standings?leagueId=104&season=${y}&standingsTypes=regularSeason`)
      .then((j) => {
        const tr = (j.records || []).flatMap((r) => r.teamRecords).find((x) => sameId(x.team.id, 134));
        return tr ? { year: y, w: tr.wins, l: tr.losses } : null;
      })
      .catch(() => null)));
  out.piratesSeasons = seasons.filter(Boolean).sort((a, b) => a.year - b.year);

  const post = await Promise.all(years(mlbYear, 12).map((y) =>
    ctx.get(`mlb-post-${y}`, `MLB · Pirates ${y} postseason`, `${MLB}/schedule?sportId=1&teamId=134&season=${y}&gameType=F,D,L,W`)
      .then((j) => (j.dates || []).flatMap((d) => d.games))
      .catch(() => [])));
  const lastPost = post.flat().sort((a, b) => Date.parse(b.gameDate) - Date.parse(a.gameDate))[0];
  out.piratesLastPostseason = lastPost
    ? { date: lastPost.gameDate, label: lastPost.seriesDescription || 'Postseason', away: lastPost.teams.away.team.name, awayScore: lastPost.teams.away.score, home: lastPost.teams.home.team.name, homeScore: lastPost.teams.home.score, sourceId: `mlb-post-${Number(lastPost.season) || new Date(lastPost.gameDate).getUTCFullYear()}` }
    : { none: true, since: mlbYear - 11 };

  const st = state.teams.steelers;
  const nflYear = Number(st?.seasonLabel) || new Date().getUTCFullYear();
  const nflTeam = TEAMS.find((t) => t.key === 'steelers');
  const nflPost = await Promise.all(years(nflYear, 12).map((y) =>
    ctx.get(`espn-nfl-post-${y}`, `ESPN · Steelers ${y} postseason`, `${ESPN}/football/nfl/teams/pit/schedule?season=${y}&seasontype=3`)
      .then((j) => espnGames(j, st?.espnId || '23', nflTeam).filter((g) => g.result).map((g) => ({ ...g, season: y })))
      .catch(() => [])));
  const pg = nflPost.flat().sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const lastWin = pg.find((g) => g.result === 'W');
  out.steelersLastPlayoffWin = lastWin
    ? { date: lastWin.date, opp: lastWin.opp.name, pf: lastWin.pf, pa: lastWin.pa, home: lastWin.home, sourceId: `espn-nfl-post-${lastWin.season}` }
    : { none: true, since: nflYear - 11 };
  out.steelersLastPlayoffGame = pg[0] ? { date: pg[0].date, opp: pg[0].opp.name, pf: pg[0].pf, pa: pg[0].pa, result: pg[0].result, sourceId: `espn-nfl-post-${pg[0].season}` } : null;

  const nhlEnd = Number(String(state.teams.penguins?.seasonLabel || '').slice(0, 4)) || new Date().getUTCFullYear();
  const brackets = await Promise.all(years(nhlEnd, 12).map((y) =>
    ctx.get(`nhl-bracket-${y}`, `NHL · ${y} playoff bracket`, `${NHL}/playoff-bracket/${y}`)
      .then((j) => ({ y, series: j.series || [] }))
      .catch(() => ({ y, series: [] }))));
  let lastSeriesWin = null;
  let lastAppearance = null;
  let latestCup = null;
  for (const { y, series } of brackets.sort((a, b) => b.y - a.y)) {
    for (const s of series) {
      const teams = [s.topSeedTeam, s.bottomSeedTeam].filter(Boolean);
      const pit = teams.find((x) => x.abbrev === 'PIT');
      if (s.playoffRound === 4 && s.winningTeamId && !latestCup) {
        latestCup = { year: y, abbr: teams.find((x) => x.id === s.winningTeamId)?.abbrev || null, sourceId: `nhl-bracket-${y}` };
      }
      if (!pit) continue;
      if (!lastAppearance) lastAppearance = { year: y, sourceId: `nhl-bracket-${y}` };
      if (!lastSeriesWin && s.winningTeamId === pit.id) {
        lastSeriesWin = { year: y, round: s.playoffRound, opp: teams.find((x) => x !== pit)?.abbrev || null, sourceId: `nhl-bracket-${y}` };
      }
    }
  }
  out.penguinsLastPlayoffs = lastAppearance;
  out.penguinsLastSeriesWin = lastSeriesWin || { none: true, since: nhlEnd - 11 };
  out.latestStanleyCup = latestCup;

  // The newest Super Bowl and World Series winners, to confirm the title clocks are still running.
  const sb = await ctx.get(`espn-superbowl-${nflYear - 1}`, `ESPN · Super Bowl (${nflYear - 1} season)`, `${ESPN}/football/nfl/scoreboard?seasontype=3&week=5&dates=${nflYear - 1}`).catch(() => null);
  const sbWinner = sb?.events?.[0]?.competitions?.[0]?.competitors?.find((c) => c.winner);
  out.latestSuperBowl = sbWinner ? { season: nflYear - 1, abbr: sbWinner.team.abbreviation, sourceId: `espn-superbowl-${nflYear - 1}` } : null;
  const ws = await ctx.get(`mlb-worldseries-${mlbYear}`, `MLB · ${mlbYear} World Series`, `${MLB}/schedule?sportId=1&season=${mlbYear}&gameType=W&hydrate=team`).catch(() => null);
  const wsGames = (ws?.dates || []).flatMap((d) => d.games).filter((g) => g.status?.detailedState === 'Final');
  const wsLast = wsGames.at(-1);
  const wsWinner = wsLast ? [wsLast.teams.away, wsLast.teams.home].find((x) => x.isWinner) : null;
  out.latestWorldSeries = wsWinner ? { season: mlbYear, abbr: wsWinner.team.abbreviation || wsWinner.team.name, sourceId: `mlb-worldseries-${mlbYear}` } : null;
  return out;
}

// ---------------------------------------------------------------- checks

const fmtWL = (r) => (r ? `${r.w}-${r.l}${r.otl != null ? `-${r.otl}` : r.t ? `-${r.t}` : ''}` : null);

// Each check compares one fact across two sources. "independent" means two
// different publishers; same-publisher checks only catch internal drift.
export function computeChecks(state) {
  const T = state.teams;
  const checks = [];
  const add = (team, label, a, b, independent, note = null, severity = null) => {
    const agree = a.value != null && b.value != null && String(a.value) === String(b.value);
    checks.push({ team, label, a, b, agree, independent, note, severity: severity || (agree ? 'ok' : 'warn') });
  };
  const tally = (games) => {
    const done = (games || []).filter((g) => g.result);
    const n = (r) => done.filter((g) => g.result === r).length;
    return { w: n('W'), l: n('L'), otl: n('OTL'), t: n('T') };
  };

  const st = T.steelers;
  if (st?.record?.summary) {
    const row = st.standing?.rows?.find((r) => r.isPgh);
    if (row) add('steelers', 'Steelers record: ESPN schedule vs ESPN standings', { src: 'espn-schedule-steelers', value: st.record.summary }, { src: 'espn-standings-steelers', value: fmtWL({ w: row.w, l: row.l, t: row.t }) }, false);
    const g = tally(st.games);
    add('steelers', 'Steelers record: ESPN record vs game-by-game results', { src: 'espn-schedule-steelers', value: st.record.summary }, { src: 'espn-schedule-steelers', value: fmtWL({ w: g.w, l: g.l, t: g.t }) }, false);
  }

  const pens = T.penguins;
  const off = pens?.official?.standing;
  if (pens?.record?.summary && off) {
    add('penguins', 'Penguins record: ESPN vs NHL', { src: 'espn-schedule-penguins', value: pens.record.summary }, { src: 'nhl-standings', value: `${off.w}-${off.l}-${off.otl}` }, true);
    add('penguins', 'Penguins points: ESPN vs NHL', { src: 'espn-standings-penguins', value: pens.record.pts }, { src: 'nhl-standings', value: off.pts }, true);
    if (pens.espnRecord && pens.espnRecord !== pens.record.summary) {
      add('penguins', "ESPN team page's record string", { src: 'espn-team-penguins', value: pens.espnRecord }, { src: 'nhl-standings', value: `${off.w}-${off.l}-${off.otl}` }, true,
        "ESPN's team page leaves overtime losses out of its record string. The dashboard uses ESPN's schedule record instead, which matches the NHL.", 'info');
    }
  }
  if (pens?.next && pens?.official?.next) {
    add('penguins', 'Penguins next game start: ESPN vs NHL', { src: 'espn-preview-penguins', value: new Date(pens.next.date).toISOString() }, { src: 'nhl-matchup', value: new Date(pens.official.next.date).toISOString() }, true);
  }

  const pir = T.pirates;
  if (pir?.record?.summary && pir.espnRecord) {
    add('pirates', 'Pirates record: MLB vs ESPN', { src: 'mlb-standings', value: pir.record.summary }, { src: 'espn-team-pirates', value: pir.espnRecord }, true);
    const g = tally(pir.games);
    add('pirates', 'Pirates record: standings vs game-by-game results', { src: 'mlb-standings', value: pir.record.summary }, { src: 'mlb-schedule', value: `${g.w}-${g.l}` }, false);
  }
  if (pir?.next && pir.espnNext) {
    add('pirates', 'Pirates next game date: MLB vs ESPN', { src: 'mlb-next-schedule', value: pir.next.day || new Date(pir.next.date).toISOString().slice(0, 10) }, { src: 'espn-team-pirates', value: etDate(pir.espnNext.date) }, true);
  }

  const pitt = T.pitt;
  if (pitt?.record?.summary) {
    const row = pitt.standing?.rows?.find((r) => r.isPgh);
    if (row) add('pitt', 'Pitt record: ESPN schedule vs ACC standings', { src: 'espn-schedule-pitt', value: pitt.record.summary }, { src: 'espn-preview-pitt', value: row.overall }, false);
    const g = tally(pitt.games);
    add('pitt', 'Pitt record: ESPN record vs game-by-game results', { src: 'espn-schedule-pitt', value: pitt.record.summary }, { src: 'espn-schedule-pitt', value: fmtWL({ w: g.w, l: g.l, t: g.t }) }, false);
  }
  return checks;
}

function etDate(iso) {
  const d = etDayNumber(iso) * DAY;
  return new Date(d).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- entry points

const BUILDERS = { steelers: buildFootball, pitt: buildFootball, penguins: buildHockey, pirates: buildBaseball };

export async function buildAll({ env = 'browser', userAgent = null, base = null } = {}) {
  const ctx = createContext({ env, userAgent });
  const entries = await Promise.all(TEAMS.map(async (t) => {
    try {
      return [t.key, await BUILDERS[t.key](ctx, t)];
    } catch (err) {
      return [t.key, { ...meta(t), unavailable: String(err.message || err) }];
    }
  }));
  let state = { generatedAt: new Date().toISOString(), env, teams: Object.fromEntries(entries), history: null, sources: ctx.sources };
  if (env === 'node') {
    state.history = await buildHistory(ctx, state).catch((err) => ({ error: String(err.message || err) }));
  } else if (base) {
    state = mergeSnapshot(state, base);
  }
  state.checks = computeChecks(state);
  return state;
}

// Carry snapshot-only fields into a live browser refresh, and keep the snapshot
// copy of any team whose live fetch failed.
export function mergeSnapshot(fresh, base) {
  for (const key of Object.keys(fresh.teams)) {
    const f = fresh.teams[key];
    const b = base.teams?.[key];
    if (!b) continue;
    if (f.unavailable && !b.unavailable) {
      fresh.teams[key] = { ...b, stale: true, liveError: f.unavailable };
      continue;
    }
    if (b.official && !f.official) f.official = b.official;
    if (b.espnRecord && !f.espnRecord) f.espnRecord = b.espnRecord;
    if (b.espnNext && !f.espnNext) f.espnNext = b.espnNext;
  }
  fresh.history = base.history || null;
  const have = new Set(fresh.sources.map((s) => s.id));
  fresh.sources = [...fresh.sources, ...(base.sources || []).filter((s) => !have.has(s.id))];
  fresh.snapshotAt = base.generatedAt;
  return fresh;
}
