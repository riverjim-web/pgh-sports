// Rule-based storylines for a team's next game.
//
// Each rule reads only the normalized feed data and returns one sentence plus
// the source ids it rests on, so every line on the page can be cited and the
// text stays true after each refresh. No sentence is written by hand per game.

import { fmtDay, fmtDayLong, fmtTime, fmtMDY, etParts, etDayNumber, ord, pct1, cap, possessive, list } from './format.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const OUT = new Set(['Out', 'Doubtful']);

// "the Steelers are" but "Pitt is": pro nicknames take plural verbs, schools singular.
const plural = (subject) => /^the /i.test(subject);
const v = (subject, many, one) => (plural(subject) ? many : one);
const DAY = 864e5;

function halfGames(g) {
  const whole = Math.floor(g);
  const half = g - whole >= 0.5;
  if (whole === 0 && half) return 'a half game';
  return `${whole}${half ? '½' : ''} game${whole === 1 && !half ? '' : 's'}`;
}

function formSummary(list, hockey) {
  const rows = (list || []).map((g) => ({ ...g, otl: hockey && g.r === 'L' && /OT|SO/.test(g.score || '') }));
  const w = rows.filter((g) => g.r === 'W').length;
  const otl = rows.filter((g) => g.otl).length;
  const l = rows.filter((g) => g.r === 'L').length - otl;
  let streak = 0;
  const lastWin = rows.at(-1)?.r === 'W';
  for (let i = rows.length - 1; i >= 0 && (rows[i].r === 'W') === lastWin; i--) streak++;
  const text = `${w}-${l}${hockey ? `-${otl}` : ''}`;
  const run = streak >= 3 ? `, ${streak} straight ${lastWin ? 'wins' : 'without a win'}` : '';
  return { w, l, otl, n: rows.length, text, run };
}

// Fourth Thursday of November.
function thanksgivingDay(year) {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  return 1 + ((4 - first + 7) % 7) + 21;
}

export function storylines(team, state, now = Date.now()) {
  const n = team?.next;
  const lines = [];
  const add = (id, weight, tone, text, sources) => lines.push({ id, weight, tone, text, sources: sources.filter(Boolean) });
  const src = (kind) => `${kind}-${team.key}`;
  if (team?.offseason) {
    offseasonLines(team, state, add, now);
    return lines.sort((a, b) => b.weight - a.weight);
  }
  if (!n || !n.opp) return lines;

  const opp = n.opp;
  const us = team.say;
  const them = opp.say;
  const hockey = team.sport === 'hockey';
  const football = team.sport === 'football';
  const kickoffWord = hockey ? 'Puck drop' : team.sport === 'baseball' ? 'First pitch' : 'Kickoff';

  // Standings stakes when the opponent shares the division or conference.
  const rows = team.standing?.rows || [];
  const me = rows.find((r) => r.isPgh);
  const foe = rows.find((r) => sameId(r.id, opp.id));
  if (me && foe) {
    const group = team.standing.group;
    if (team.league === 'NHL') {
      const gap = me.pts - foe.pts;
      add('stakes', 90, gap >= 0 ? 'good' : 'bad',
        `Division game: ${us} (${me.pts} pts) ${gap === 0 ? `${v(us, 'are', 'is')} level with ${them}` : gap > 0 ? `${v(us, 'lead', 'leads')} ${them} by ${gap} points` : `${v(us, 'trail', 'trails')} ${them} by ${-gap} points`} in the ${group}.`,
        team.standing.sources);
    } else if (team.league === 'NCAAF') {
      add('stakes', 75, (me.cw ?? 0) >= (foe.cw ?? 0) ? 'good' : 'bad',
        `Conference game: ${us} ${v(us, 'are', 'is')} ${me.conf} in league play (${ord(team.standing.rank)} in the ${team.standing.group}); ${them} ${v(them, 'are', 'is')} ${foe.conf}.`,
        team.standing.sources);
    } else {
      const gap = ((me.w - foe.w) + (foe.l - me.l)) / 2;
      const top = rows.indexOf(me) === 0 || rows.indexOf(foe) === 0;
      const lead = gap === 0 ? `${v(us, 'are', 'is')} tied with ${them}` : gap > 0 ? `${v(us, 'lead', 'leads')} ${them} by ${halfGames(gap)}` : `${v(us, 'trail', 'trails')} ${them} by ${halfGames(-gap)}`;
      add('stakes', 95, gap >= 0 ? 'good' : 'bad',
        `${top && Math.abs(gap) <= 1 ? 'First place on the line' : 'Division game'}: ${us} (${me.w}-${me.l}${me.t ? `-${me.t}` : ''}) ${lead} in the ${group}.`,
        team.standing.sources);
    }
  }

  // Rematch of an earlier meeting this season.
  const prev = (team.games || []).filter((g) => g.result && sameId(g.opp?.id, opp.id) && Date.parse(g.date) < Date.parse(n.date)).at(-1);
  if (prev) {
    const won = prev.result === 'W';
    const hi = Math.max(prev.pf, prev.pa);
    const lo = Math.min(prev.pf, prev.pa);
    add('rematch', 80, won ? 'good' : 'bad',
      `Rematch: ${us} ${won ? 'beat' : 'lost to'} ${them} ${hi}-${lo}${prev.extra ? ` in ${prev.extra}` : ''} ${prev.home ? 'at home' : 'on the road'} on ${fmtDay(prev.date)}${prev.label ? ` (${prev.label})` : ''}.`,
      [src('espn-schedule')]);
  } else if (n.series?.total > 1) {
    add('series', 25, 'neutral', `First of ${n.series.total} meetings this season.`, n.sources);
  }

  // Rest and back-to-backs.
  const nextDay = etDayNumber(n.date);
  const lastOurs = (team.games || []).filter((g) => g.result && Date.parse(g.date) < Date.parse(n.date)).at(-1);
  const lastTheirs = n.form?.opp?.at(-1);
  const restUs = lastOurs ? nextDay - etDayNumber(lastOurs.date) : null;
  const restThem = lastTheirs?.date ? nextDay - etDayNumber(lastTheirs.date) : null;
  if (football && restUs != null) {
    if (restUs >= 12 && restThem != null && restThem >= 12) {
      add('rest', 45, 'neutral', `Both teams are coming off a bye: ${restUs} days of rest for ${us}, ${restThem} for ${them}.`, [src('espn-schedule'), src('espn-preview')]);
    } else if (restUs >= 12) {
      add('rest', 60, 'good', `Coming off the bye: ${restUs} days between games for ${us}${restThem != null ? `, ${restThem} for ${them}` : ''}.`, [src('espn-schedule'), src('espn-preview')]);
    } else if (restThem != null && restThem >= 12) {
      add('rest', 60, 'bad', `${cap(them)} ${v(them, 'come', 'comes')} off a bye with ${restThem} days of rest; ${us} ${v(us, 'get', 'gets')} ${restUs}.`, [src('espn-schedule'), src('espn-preview')]);
    } else if (restUs <= 5) {
      add('rest', 55, 'bad', `Short week: ${restUs} days since ${us} last played.`, [src('espn-schedule')]);
    }
  }
  if (hockey) {
    const playedYesterday = (team.games || []).some((g) => g.state === 'post' && etDayNumber(g.date) === nextDay - 1);
    const tomorrow = (team.games || []).find((g) => g.state !== 'post' && etDayNumber(g.date) === nextDay + 1);
    if (playedYesterday) add('b2b', 60, 'bad', `Second night of a back-to-back for ${us}.`, [src('espn-schedule')]);
    else if (tomorrow) add('b2b', 50, 'neutral', `First half of a back-to-back: ${us} ${tomorrow.home ? 'host' : 'visit'} ${tomorrow.opp.say} the next night.`, [src('espn-schedule')]);
    if (restThem === 1) add('b2b-opp', 45, 'good', `${cap(them)} played the night before.`, [src('espn-preview')]);
  }

  // Road trips and homestands (hockey and baseball schedules run in stretches).
  if (!football) {
    const g = team.games || [];
    const i = g.findIndex((x) => x.id === n.id);
    if (i >= 0) {
      let start = i;
      while (start > 0 && g[start - 1].home === n.home) start--;
      let end = i;
      while (end < g.length && g[end].home === n.home) end++;
      const stretch = g.slice(start, end);
      if (stretch.length >= 3) {
        add('trip', 45, 'neutral', `${n.home ? 'Homestand' : 'Road trip'}: game ${i - start + 1} of ${stretch.length} (${stretch.map((x) => x.opp.abbr).join(', ')}).`, [src('espn-schedule')]);
      }
    }
  }

  // Recent form.
  if (n.form?.pgh?.length) {
    const a = formSummary(n.form.pgh, hockey);
    const b = formSummary(n.form.opp, hockey);
    const l10 = hockey && matchedOfficial(team)?.last10?.pgh?.record;
    add('form', 50, a.w >= 3 ? 'good' : a.w <= 1 ? 'bad' : 'neutral',
      `Last five: ${us} ${v(us, 'are', 'is')} ${a.text}${a.run}${l10 ? ` (${l10} over the last 10)` : ''}; ${them} ${v(them, 'are', 'is')} ${b.text}${b.run}.`,
      [src('espn-preview'), l10 ? 'nhl-rightrail' : null]);
  }

  // ESPN's matchup model.
  if (n.predictor?.pgh != null) {
    const p = n.predictor.pgh;
    add('predictor', 70, p >= 55 ? 'good' : p <= 45 ? 'bad' : 'neutral',
      `ESPN's matchup model gives ${us} a ${Math.round(p)}% chance to win${p < 50 ? `, making them the underdog` : p > 50 ? ', making them the favorite' : ''}.`,
      [src('espn-preview')]);
  }

  // Home and road splits.
  const ourSplit = n.home ? n.records?.pgh?.home : n.records?.pgh?.road;
  const theirSplit = n.home ? n.records?.opp?.road : n.records?.opp?.home;
  if (ourSplit && theirSplit && !n.neutral) {
    add('splits', 40, 'neutral', `${cap(us)} ${v(us, 'are', 'is')} ${ourSplit} ${n.home ? 'at home' : 'on the road'}; ${them} ${v(them, 'are', 'is')} ${theirSplit} ${n.home ? 'away' : 'at home'}.`, [src('espn-preview')]);
  }

  // Time slot.
  const p = etParts(n.date);
  const tv = (n.broadcasts || []).join(', ');
  if (team.league === 'NFL') {
    const slot = p.wd === 'Sun' && p.h >= 19 ? 'Sunday Night Football' : p.wd === 'Mon' ? 'Monday Night Football' : p.wd === 'Thu' ? 'Thursday Night Football' : null;
    if (slot) add('slot', 65, 'neutral', `Prime time: ${slot}, ${fmtTime(n.date)} ET${tv ? ` on ${tv}` : ''}.`, [src('espn-preview')]);
  } else if (team.league === 'NCAAF' && p.wd === 'Fri') {
    add('slot', 45, 'neutral', `Friday night game: ${fmtTime(n.date)} ET${tv ? ` on ${tv}` : ''}.`, [src('espn-preview')]);
  } else if (hockey && p.h >= 22) {
    add('slot', 40, 'neutral', `Late one: ${kickoffWord.toLowerCase()} is ${fmtTime(n.date)} ET.`, [src('espn-preview')]);
  }

  // Calendar quirks.
  const tg = thanksgivingDay(p.y);
  const quirk = p.wd === 'Fri' && p.d === 13 ? `${kickoffWord} lands on Friday the 13th.`
    : p.m === 11 && p.d === tg ? `Thanksgiving ${hockey ? 'hockey' : 'football'}.`
    : p.m === 11 && p.d === tg + 1 ? 'A Black Friday game.'
    : p.m === 12 && p.d === 25 ? 'A Christmas Day game.'
    : p.m === 10 && p.d === 31 ? 'A Halloween game.'
    : p.m === 12 && p.d === 31 ? "A New Year's Eve game."
    : p.m === 1 && p.d === 1 ? "A New Year's Day game."
    : null;
  if (quirk) add('quirk', 30, 'fun', quirk, [src('espn-preview')]);

  // Ranked opponent (college).
  if (opp.rank) add('rank', 72, 'neutral', `${cap(them)} ${v(them, 'are', 'is')} ranked No. ${opp.rank}.`, [src('espn-preview')]);
  if (n.pghRank) add('rank-us', 72, 'good', `${cap(us)} ${v(us, 'are', 'is')} ranked No. ${n.pghRank}.`, [src('espn-preview')]);

  // Game-day weather for outdoor venues.
  const w = n.weather;
  if (w && w.tempF != null) {
    const rough = w.windMph >= 15 || (w.precip ?? 0) >= 50 || w.tempF <= 32;
    add('weather', rough ? 62 : 35, rough ? 'bad' : 'neutral',
      `${w.longRange ? 'Long-range forecast' : 'Forecast'} for ${kickoffWord.toLowerCase()} in ${n.venue.city}: ${w.tempF}°F, ${w.text.toLowerCase()}, wind ${w.windMph} mph${w.precip != null ? `, ${w.precip}% chance of precipitation` : ''}.`,
      [w.sourceId]);
  } else if (football && n.venue?.indoor === true) {
    add('weather', 12, 'neutral', `Indoors at ${n.venue.name}, so weather is out of play.`, [src('espn-preview')]);
  }

  // Injuries: only statuses that rule a player out of this game.
  if (n.injuries) {
    const outOf = (side) => (n.injuries[side] || []).filter((i) => OUT.has(i.status));
    const name = (i) => `${i.pos ? `${i.pos} ` : ''}${i.name}${i.status === 'Doubtful' ? ' (doubtful)' : ''}`;
    const a = outOf('pgh');
    const b = outOf('opp');
    if (a.length) add('inj-pgh', 55, 'bad', `${cap(us)} will be without ${list(a.slice(0, 4).map(name))}${a.length > 4 ? ` and ${a.length - 4} more` : ''}.`, [src('espn-preview')]);
    if (b.length) add('inj-opp', 50, 'good', `${cap(them)} will be without ${list(b.slice(0, 4).map(name))}${b.length > 4 ? ` and ${b.length - 4} more` : ''}.`, [src('espn-preview')]);
  }

  // Hockey-only detail from the NHL's own feed (snapshot).
  const off = matchedOfficial(team);
  if (off?.special?.pgh && off.special.opp) {
    const a = off.special.pgh;
    const b = off.special.opp;
    if (b.pkRank >= 26) {
      add('pk', 68, 'good', `${possessive(cap(them))} penalty kill ranks ${ord(b.pkRank)} in the NHL (${pct1(b.pk)}), an opening for a ${team.name} power play that ranks ${ord(a.ppRank)} (${pct1(a.pp)}).`, ['nhl-rightrail']);
    } else if (a.ppRank >= 26) {
      add('pp', 55, 'bad', `The ${team.name} power play ranks ${ord(a.ppRank)} (${pct1(a.pp)}).`, ['nhl-rightrail']);
    }
    if (a.gaRank >= 26) add('ga', 56, 'bad', `${cap(us)} allow ${a.ga.toFixed(2)} goals per game, ${ord(a.gaRank)} in the league.`, ['nhl-rightrail']);
    if (a.foRank >= 28) add('fo', 30, 'bad', `${cap(us)} rank ${ord(a.foRank)} on faceoffs (${pct1(a.fo)}).`, ['nhl-rightrail']);
  }
  if (off?.goalies?.pgh?.[0] && off.goalies.opp?.[0]) {
    const g = (x) => `${x.name} (${x.record}, ${x.svp.toFixed(3).replace(/^0/, '')})`;
    add('goalies', 46, 'neutral', `In net, by most starts: ${g(off.goalies.pgh[0])} for ${us}, ${g(off.goalies.opp[0])} for ${them}. Starters are not confirmed until warmups.`, ['nhl-matchup']);
  }
  if (off?.coaches?.pgh && off.coaches.opp) {
    add('coaches', 15, 'neutral', `Behind the benches: ${off.coaches.pgh} and ${off.coaches.opp}.`, ['nhl-rightrail']);
  }

  return lines.sort((a, b) => b.weight - a.weight);
}

// The NHL feed's next game, if it is the same game ESPN calls next.
export function matchedOfficial(team) {
  const off = team?.official?.next;
  if (!off || !team.next) return null;
  return Math.abs(Date.parse(off.date) - Date.parse(team.next.date)) < 3 * 36e5 ? off : null;
}

function offseasonLines(team, state, add, now) {
  const o = team.offseason;
  const me = team.standing?.rows?.find((r) => r.isPgh);
  const hist = state?.history;
  if (o.openingDay) {
    const days = Math.ceil((Date.parse(o.openingDay.day || o.openingDay.date) - now) / DAY);
    add('opening', 90, 'good', `Opening Day ${o.upcomingYear} is ${fmtDayLong(o.openingDay.day ? `${o.openingDay.day}T16:00:00Z` : o.openingDay.date)}, ${o.openingDay.home ? 'home against' : 'at'} ${o.openingDay.opp.say}${o.openingDay.venue ? ` at ${o.openingDay.venue.name}` : ''}: ${days} days away.`, ['mlb-next-schedule']);
  }
  if (o.springOpener) {
    add('spring', 70, 'neutral', `Spring training opens ${fmtDay(`${o.springOpener.day}T16:00:00Z`)} ${o.springOpener.home ? 'against' : 'at'} ${o.springOpener.opp.say}${o.springOpener.venue ? ` at ${o.springOpener.venue.name}` : ''}.`, ['mlb-next-schedule']);
  }
  if (me) {
    add('recap', 85, me.w > me.l ? 'good' : 'bad',
      `${o.resultsYear} finished ${me.w}-${me.l}, ${ord(me.rank)} in the ${team.standing.group}${me.wcgb && me.wcgb !== '-' ? `, ${me.wcgb} games out of a Wild Card spot` : ''}.`,
      ['mlb-standings']);
    if (hist?.piratesSeasons?.length && me.w > me.l) {
      const before = hist.piratesSeasons.filter((s) => s.year < o.resultsYear);
      const prior = before.filter((s) => s.w > s.l).at(-1);
      if (prior && prior.year < o.resultsYear - 1) {
        add('winning', 82, 'good', `First winning season since ${prior.year} (${prior.w}-${prior.l}).`, [`mlb-standings-${prior.year}`, `mlb-standings-${o.resultsYear - 1}`]);
      } else if (!prior && before.length) {
        add('winning', 82, 'good', `First winning season in at least ${before.length} years.`, [`mlb-standings-${before[0].year}`]);
      }
    }
  }
  const fa = (o.moves || []).filter((m) => /elected free agency/i.test(m.text));
  for (const m of fa) {
    const leader = (o.leaders || []).find((L) => L.name && m.text.includes(L.name));
    if (leader) add(`fa-${leader.name}`, 80, 'bad', `${leader.name}, the team leader with ${leader.value} ${leader.cat}, elected free agency on ${fmtDay(`${m.date}T16:00:00Z`)}.`, ['mlb-transactions', 'mlb-leaders']);
  }
  if (fa.length) {
    add('fa', 60, 'neutral', `${fa.length} player${fa.length === 1 ? ' has' : 's have'} elected free agency since ${fmtDay(`${fa.at(-1).date}T16:00:00Z`)}.`, ['mlb-transactions']);
  }
  const back = (o.moves || [])
    .map((m) => m.text.match(/activated (.+?) from the (\d+)-day injured list/i))
    .filter(Boolean)
    .map((x) => x[1]);
  if (back.length) add('il', 40, 'good', `Back from the injured list: ${list(back.slice(0, 3))}.`, ['mlb-transactions']);
  const lp = hist?.piratesLastPostseason;
  if (lp?.date) {
    const days = Math.floor((now - Date.parse(lp.date)) / DAY);
    add('drought', 55, 'bad', `The last Pirates postseason game was the ${fmtMDY(lp.date)} ${lp.label}: ${days.toLocaleString('en-US')} days ago.`, [lp.sourceId]);
  }
}
