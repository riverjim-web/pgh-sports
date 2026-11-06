// Pittsburgh Sports Dashboard. Renders data/snapshot.json at once, then
// refreshes from the feeds that allow browser requests: every 5 minutes, or
// every 30 seconds while a Pittsburgh team is playing.

import { buildAll, TEAMS } from './feeds.js';
import { storylines, matchedOfficial } from './storylines.js';
import { fmtDay, fmtDayLong, fmtTime, fmtTimeIn, fmtClock, fmtMD, fmtMDY, fmtMonth, etParts, ord, cap, countdown, ago } from './format.js';

const POLL_MS = 5 * 60e3;
const LIVE_POLL_MS = 30e3;
const DAY = 864e5;
const SVG_NS = 'http://www.w3.org/2000/svg';
const OUR_ABBR = { steelers: 'PIT', penguins: 'PIT', pirates: 'PIT', pitt: 'PITT' };

let state = null;
let titles = null;
let mode = 'loading';
let liveAt = 0;
let pollTimer = null;
let refreshing = false;
let moodAngle = 0;
const ui = { team: TEAMS[0].key, yinzer: false, showAll: false, game: null };

// ---------------------------------------------------------------- words

const WORDS = {
  std: {
    eyebrow: 'Steelers · Penguins · Pirates · Pitt',
    brand: 'Pittsburgh Sports',
    yinzer: 'Yinzer mode',
    upnext: 'Up next',
    next: 'Next game',
    stories: 'Storylines',
    storiesNote: 'Written by rules from the feeds, strongest first',
    more: 'Show all',
    fewer: 'Show fewer',
    players: 'Players to watch',
    leaders: 'Season leaders',
    injuries: 'Injury report',
    goalies: 'Goalies, by starts',
    hot: 'Hot over the last 5 games',
    moves: 'Roster moves, last 45 days',
    noInjuries: 'No one listed.',
    collegeInjuries: 'College football has no league-wide injury report, so none is shown.',
    winprob: 'ESPN win probability',
    weather: 'Forecast',
    season: 'Season',
    standings: 'Standings',
    chart: 'Game by game',
    mood: 'City mood',
    moodHow: 'How this is computed',
    moods: ['Gloomy', 'Uneasy', 'Hopeful', 'Buzzing', 'Planning the parade route'],
    map: 'Where they play',
    parade: 'Since the last parade',
    sources: 'Sources and checks',
    live: 'Live',
    snapshot: 'Snapshot',
    offline: 'Feeds unreachable',
    loading: 'Loading feeds…',
    downtown: 'Downtown',
    northShore: 'North Shore',
    point: 'The Point',
  },
  yinz: {
    eyebrow: 'Stillers · Pens · Buccos · Pitt',
    brand: 'Picksburgh Sports',
    upnext: "Who're we playin' next?",
    next: "Next game, n'at",
    stories: "What yinz'll be talkin' abaht",
    storiesNote: 'Straight from the feeds, honest',
    more: 'Show me all of it',
    fewer: "Less, n'at",
    players: 'Who to keep an eye on',
    leaders: 'The big guns',
    injuries: "Who's hurtin'",
    goalies: "Who's in net",
    hot: "Who's been hot lately",
    moves: "Comin's and goin's",
    noInjuries: 'Nobody, knock on wood.',
    collegeInjuries: "College ball don't put aht an injury report.",
    winprob: "ESPN's chances, n'at",
    weather: "Gonna be slippy aht?",
    season: "How we been doin'",
    standings: "Where we're at",
    chart: "Every game, n'at",
    mood: "How's the 'Burgh feelin'?",
    moodHow: "How'd yinz figure that?",
    moods: ['Grumpier than the Parkway at rush hour', "Worried, n'at", 'Hopeful, yinz', "Buzzin' like the Strip on a Saturday", 'Redd up dahntahn fer the parade'],
    map: 'Dahn by the rivers',
    parade: 'Since the last parade dahntahn',
    sources: 'Where we got all this',
    downtown: 'Dahntahn',
  },
};
const NICKS = {
  std: { steelers: 'Steelers', penguins: 'Penguins', pirates: 'Pirates', pitt: 'Pitt' },
  yinz: { steelers: 'Stillers', penguins: 'Pens', pirates: 'Buccos', pitt: 'Pitt' },
};
const say = (k) => (ui.yinzer && WORDS.yinz[k] != null ? WORDS.yinz[k] : WORDS.std[k] ?? k);
const nick = (key) => NICKS[ui.yinzer ? 'yinz' : 'std'][key];
function yinzify(text) {
  if (!ui.yinzer || !text) return text;
  return text
    .replace(/\bSteelers\b/g, 'Stillers')
    .replace(/\bPenguins\b/g, 'Pens')
    .replace(/\bPirates\b/g, 'Buccos')
    .replace(/\bPittsburgh\b/g, 'Picksburgh')
    .replace(/\bdowntown\b/g, 'dahntahn');
}

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...kids) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
const S = (tag, attrs, ...kids) => h(`svg:${tag}`, attrs, ...kids);

function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`pgh-${key}`);
    localStorage.setItem(`pgh-${key}`, value);
  } catch {
    return null;
  }
  return value;
}

async function getJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const noonET = (day) => `${day}T17:00:00Z`;
// The UTC instant of midnight in Pittsburgh on a YYYY-MM-DD date.
function etMidnight(day) {
  for (const off of [4, 5]) {
    const iso = `${day}T0${off}:00:00Z`;
    const p = etParts(iso);
    if (p.h === 0) return iso;
  }
  return `${day}T05:00:00Z`;
}
const startOf = (n) => (n.tbd && n.day ? etMidnight(n.day) : n.date);
const whenShort = (n) => (n.tbd && n.day ? `${fmtDay(noonET(n.day))} · time TBA` : `${fmtDay(n.date)} · ${fmtTime(n.date)} ET`);
const vsAt = (g) => (g.home || g.neutral ? 'vs' : 'at');
const signed = (x) => {
  if (x == null || x === '') return null;
  if (typeof x === 'string' && /^[+-]/.test(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n}` : String(x);
};
const scoreText = (g) => `${Math.max(g.pf, g.pa)}-${Math.min(g.pf, g.pa)}`;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const SHORT = [
  [/^espn-preview/, 'ESPN preview'], [/^espn-schedule/, 'ESPN schedule'], [/^espn-standings/, 'ESPN standings'], [/^espn-team/, 'ESPN team'],
  [/^espn-nfl-post/, 'ESPN playoffs'], [/^espn-superbowl/, 'ESPN Super Bowl'],
  [/^nhl-rightrail/, 'NHL team stats'], [/^nhl-matchup/, 'NHL matchup'], [/^nhl-standings/, 'NHL standings'], [/^nhl-bracket/, 'NHL playoffs'], [/^nhl-/, 'NHL'],
  [/^mlb-standings-\d/, 'MLB history'], [/^mlb-post/, 'MLB postseason'], [/^mlb-next-schedule/, 'MLB schedule'], [/^mlb-schedule/, 'MLB results'],
  [/^mlb-standings/, 'MLB standings'], [/^mlb-transactions/, 'MLB transactions'], [/^mlb-leaders/, 'MLB leaders'], [/^mlb-/, 'MLB'],
  [/^nws/, 'NWS forecast'], [/^meteo/, 'Open-Meteo'], [/^geo/, 'Open-Meteo'],
];
const shortLabel = (id) => {
  const base = SHORT.find(([re]) => re.test(id))?.[1] || id;
  const year = id.match(/-(\d{4})$/)?.[1];
  return year ? `${base} ${year}` : base;
};

function srcChip(id) {
  if (!id) return null;
  return h('button', { type: 'button', class: 'src', title: `Source: ${state?.sources?.find((s) => s.id === id)?.label || id}`, onclick: () => showSource(id), text: shortLabel(id) });
}

function showSource(id) {
  const list = document.getElementById('source-list');
  if (!list) return;
  list.open = true;
  const row = list.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1800);
}

// ---------------------------------------------------------------- up next

function renderUpNext() {
  const sec = document.getElementById('upnext');
  if (!state) return;
  const teams = TEAMS.map((t) => state.teams[t.key]).filter(Boolean);
  const when = (t) => (t.next ? Date.parse(startOf(t.next)) : Infinity);
  teams.sort((a, b) => when(a) - when(b));
  const cards = teams.map((t) => {
    const n = t.next;
    if (t.unavailable || !n) {
      return h('li', {}, h('div', { class: `nextcard team-${t.key}` },
        h('span', { class: 'nc-team', text: nick(t.key) }),
        h('span', { class: 'nc-where', text: t.unavailable ? 'Feed unavailable right now' : 'Nothing on the schedule' })));
    }
    const live = t.live;
    return h('li', {}, h('button', {
      type: 'button', class: `nextcard team-${t.key}`, 'aria-current': String(ui.team === t.key),
      onclick: () => selectTeam(t.key, true),
    },
      h('span', { class: 'nc-top' },
        h('span', { class: 'nc-team', text: nick(t.key) }),
        live
          ? h('span', { class: 'nc-count nc-live', text: 'LIVE' })
          : h('span', { class: 'nc-count', 'data-countdown': startOf(n), text: countdown(Date.parse(startOf(n)) - Date.now()) })),
      h('span', { class: 'nc-opp' }, h('span', { class: 'nc-vs', text: `${vsAt(n)} ` }), n.opp.short || n.opp.name),
      h('span', { class: 'nc-when', text: live ? `${live.detail} · ${OUR_ABBR[t.key]} ${live.pgh}, ${live.oppAbbr} ${live.opp}` : whenShort(n) }),
      h('span', { class: 'nc-where', text: [n.venue?.name, (n.broadcasts || []).join(', ')].filter(Boolean).join(' · ') }),
      n.kind ? h('span', { class: 'nc-kind', text: n.kind }) : null));
  });
  sec.replaceChildren(h('h2', { class: 'section-label', id: 'upnext-title', text: say('upnext') }), h('ol', { class: 'rail' }, cards));
}

// ---------------------------------------------------------------- tabs

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.replaceChildren(...TEAMS.map((t) => {
    const d = state?.teams?.[t.key];
    const on = ui.team === t.key;
    return h('button', {
      type: 'button', role: 'tab', id: `tab-${t.key}`, class: `tab team-${t.key}`,
      'aria-selected': String(on), 'aria-controls': 'team-view', tabindex: on ? '0' : '-1',
      onclick: () => selectTeam(t.key), onkeydown: tabKeys,
    }, h('span', { class: 'tab-name', text: nick(t.key) }), h('span', { class: 'tab-rec', text: d?.record?.summary || '' }));
  }));
  document.getElementById('team-view').setAttribute('aria-labelledby', `tab-${ui.team}`);
}

function tabKeys(e) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const i = TEAMS.findIndex((t) => t.key === ui.team);
  const key = TEAMS[(i + step + TEAMS.length) % TEAMS.length].key;
  selectTeam(key);
  document.getElementById(`tab-${key}`)?.focus();
}

function selectTeam(key, scroll = false) {
  if (!TEAMS.some((t) => t.key === key)) return;
  ui.team = key;
  ui.showAll = false;
  ui.game = null;
  if (location.hash !== `#${key}`) window.history.replaceState(null, '', `#${key}`);
  renderUpNext();
  renderTabs();
  renderTeam();
  if (scroll) document.getElementById('tabs').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- team view

function renderTeam() {
  const root = document.getElementById('team-view');
  const t = state?.teams?.[ui.team];
  root.className = `team-view team-${ui.team}`;
  if (!t) {
    root.replaceChildren(h('p', { class: 'placeholder', text: say('loading') }));
    return;
  }
  if (t.unavailable) {
    root.replaceChildren(h('div', { class: 'card unavailable' },
      h('h2', { class: 'matchup-title', text: nick(t.key) }),
      h('p', { text: `The ${t.league} feed did not answer (${t.unavailable}). The page will try again on the next refresh.` }),
      h('p', {}, h('button', { type: 'button', class: 'linkbtn', onclick: () => refresh(), text: 'Try again now' }))));
    return;
  }
  root.replaceChildren(previewCard(t), seasonCard(t));
}

function slotName(t, n) {
  const p = etParts(n.date);
  if (t.league === 'NFL') {
    if (p.wd === 'Sun' && p.h >= 19) return 'Sunday Night Football';
    if (p.wd === 'Mon') return 'Monday Night Football';
    if (p.wd === 'Thu') return 'Thursday Night Football';
  }
  if (t.league === 'NCAAF' && p.wd === 'Fri') return 'Friday night';
  return null;
}

function fact(label, value, sub) {
  return h('div', { class: 'fact' }, h('dt', { text: label }), h('dd', {}, value, sub ? h('div', { class: 'sub', text: sub }) : null));
}

function previewCard(t) {
  const n = t.next;
  const card = h('article', { class: 'card preview', 'aria-labelledby': 'preview-title' });
  if (!n) {
    return append(card, [h('p', { class: 'eyebrow', text: say('next') }), h('h2', { id: 'preview-title', class: 'matchup-title', text: 'Nothing scheduled' })]);
  }
  const game = (t.games || []).find((g) => g.id === n.id);
  const off = matchedOfficial(t);
  const local = off?.venueTimezone && off.venueTimezone !== 'America/New_York' && off.venueTimezone !== 'US/Eastern' ? fmtTimeIn(n.date, off.venueTimezone) : null;
  const oppStyle = n.opp.color ? `--opp:${n.opp.color}` : null;
  const place = [n.venue?.city, n.venue?.state].filter(Boolean).join(', ');
  return append(card, [
    h('p', { class: 'eyebrow', text: [say('next'), game?.label, n.kind, slotName(t, n)].filter(Boolean).join(' · ') }),
    h('div', { class: 'matchup' },
      h('h2', { id: 'preview-title', class: 'matchup-title' }, nick(t.key), h('span', { class: 'vs', text: ` ${vsAt(n)} ` }), n.opp.short || n.opp.name)),
    t.live ? h('div', { class: 'liveband' },
      h('span', { class: 'tag', text: 'LIVE' }),
      h('span', { class: 'score', text: `${OUR_ABBR[t.key]} ${t.live.pgh ?? 0} · ${t.live.oppAbbr} ${t.live.opp ?? 0}` }),
      h('span', { text: t.live.detail })) : null,
    h('dl', { class: 'facts' },
      fact('When', n.tbd && n.day ? `${fmtDayLong(noonET(n.day))}, time TBA` : `${fmtDayLong(n.date)}, ${fmtTime(n.date)} ET`, local ? `${local} local time` : null),
      fact('Where', n.venue?.name || 'TBA', place || null),
      n.broadcasts?.length ? fact('Watch', n.broadcasts.join(', ')) : null,
      h('div', { class: 'fact' }, h('dt', { text: 'Starts' }), h('dd', {},
        h('span', { class: 'countpill', 'data-countdown': startOf(n), text: countdown(Date.parse(startOf(n)) - Date.now()) })))),
    n.predictor?.pgh != null ? h('div', { class: 'prob', style: oppStyle },
      h('div', { class: 'block-head' }, h('span', { class: 'section-label', text: say('winprob') }), srcChip(`espn-preview-${t.key}`)),
      h('div', { class: 'prob-bar', role: 'img', 'aria-label': `${nick(t.key)} ${n.predictor.pgh}%, ${n.opp.short} ${n.predictor.opp}%` },
        h('span', { class: 'p-us', style: `width:${n.predictor.pgh}%` }),
        h('span', { class: 'p-them', style: `width:${n.predictor.opp ?? 100 - n.predictor.pgh}%` })),
      h('div', { class: 'prob-legend' },
        h('span', { text: `${OUR_ABBR[t.key]} ${n.predictor.pgh.toFixed(1)}%` }),
        h('span', { text: `${n.opp.abbr} ${(n.predictor.opp ?? 100 - n.predictor.pgh).toFixed(1)}%` }))) : null,
    weatherLine(t, n),
    t.offseason ? openerBlock(t) : null,
    storiesBlock(t),
    playersBlock(t),
    linksBlock(n),
  ]);
}

function weatherLine(t, n) {
  const w = n.weather;
  if (w?.tempF != null) {
    return h('div', { class: 'weather' },
      h('span', { class: 'section-label', text: say('weather') }),
      h('strong', { text: `${w.tempF}°F` }),
      h('span', { text: [w.text, `wind ${w.windMph} mph`, w.precip != null ? `${w.precip}% precip` : null, w.longRange ? 'long range' : null].filter(Boolean).join(' · ') }),
      srcChip(w.sourceId));
  }
  if (w?.pending) return h('p', { class: 'weather', text: `${say('weather')}: shows up about two weeks out.` });
  return null;
}

function openerBlock(t) {
  const o = t.offseason?.openingDay;
  if (!o) return null;
  const at = etMidnight(o.day);
  return h('div', { class: 'opener block' },
    h('span', { class: 'section-label', text: `Opening Day ${t.offseason.upcomingYear}` }),
    h('span', { class: 'big', 'data-countdown': at, text: countdown(Date.parse(at) - Date.now()) }),
    h('span', { text: `${fmtDayLong(noonET(o.day))} · ${o.home ? 'vs' : 'at'} ${o.opp.name}${o.venue ? ` · ${o.venue.name}` : ''}` }),
    srcChip('mlb-next-schedule'));
}

function storiesBlock(t) {
  const lines = storylines(t, state);
  if (!lines.length) return null;
  const shown = ui.showAll ? lines : lines.slice(0, 6);
  return h('section', { class: 'block', 'aria-labelledby': 'stories-title' },
    h('div', { class: 'block-head' },
      h('h3', { id: 'stories-title', class: 'section-label', text: say('stories') }),
      h('span', { class: 'small muted', text: say('storiesNote') })),
    h('ul', { class: 'stories' }, shown.map((l) => h('li', { class: 'story', 'data-tone': l.tone },
      h('span', { class: 'story-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'story-text' }, h('span', { text: yinzify(l.text) }), l.sources.map(srcChip))))),
    lines.length > 6 ? h('button', {
      type: 'button', class: 'linkbtn', 'aria-expanded': String(ui.showAll),
      onclick: () => { ui.showAll = !ui.showAll; renderTeam(); },
      text: ui.showAll ? say('fewer') : `${say('more')} (${lines.length})`,
    }) : null);
}

function kvList(rows) {
  return h('dl', { class: 'kv' }, rows.map(([dt, dd, stat]) => h('div', { class: 'kv-row' },
    h('dt', { text: dt }), h('dd', {}, dd || '—', stat ? h('div', { class: 'stat', text: stat }) : null))));
}

function injuryList(items) {
  if (!items?.length) return h('p', { class: 'small', text: say('noInjuries') });
  const order = { Out: 0, Doubtful: 1, Questionable: 2 };
  const sorted = [...items].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  return h('ul', { class: 'inj' },
    sorted.slice(0, 8).map((i) => h('li', {},
      h('span', { class: 'status-chip', 'data-s': i.status, text: i.status }),
      h('span', { text: `${i.pos ? `${i.pos} ` : ''}${i.name}` }),
      i.detail ? h('span', { class: 'muted', text: i.detail }) : null)),
    sorted.length > 8 ? h('li', { class: 'muted', text: `and ${sorted.length - 8} more` }) : null);
}

function duo(t, n, title, render, src) {
  return h('div', { class: 'kv' },
    h('div', { class: 'block-head' }, h('h4', { class: 'eyebrow', text: title }), srcChip(src)),
    h('div', { class: 'duo' },
      h('div', { class: 'duo-col' },
        h('div', { class: 'duo-head' }, h('span', { class: `chip team-${t.key}`, text: OUR_ABBR[t.key] }), nick(t.key)),
        render('pgh')),
      h('div', { class: 'duo-col' },
        h('div', { class: 'duo-head' }, h('span', { class: 'chip opp', style: n.opp.color ? `--opp:${n.opp.color}` : null, text: n.opp.abbr }), n.opp.short),
        render('opp'))));
}

function playersBlock(t) {
  if (t.offseason) return offseasonPlayers(t);
  const n = t.next;
  if (!n) return null;
  const off = matchedOfficial(t);
  const parts = [];
  if (off?.goalies?.pgh?.length) {
    parts.push(duo(t, n, say('goalies'), (side) => kvList(off.goalies[side].slice(0, 2).map((g) => [
      `${g.gp} GP`, g.name, `${g.record} · ${g.svp.toFixed(3).replace(/^0/, '')} SV% · ${g.gaa.toFixed(2)} GAA`,
    ])), 'nhl-matchup'));
  }
  if (off?.lastFive?.length) {
    parts.push(duo(t, n, say('hot'), (side) => kvList(off.lastFive.map((L) => [cap(L.cat), L[side]?.name, L[side] ? `${L[side].value}` : null])), 'nhl-matchup'));
  }
  if (n.leaders?.pgh?.length) {
    parts.push(duo(t, n, say('leaders'), (side) => kvList(n.leaders[side].map((L) => [L.cat, L.name, L.value])), `espn-preview-${t.key}`));
  }
  if (n.injuries) parts.push(duo(t, n, say('injuries'), (side) => injuryList(n.injuries[side]), `espn-preview-${t.key}`));
  else if (t.league === 'NCAAF') parts.push(h('p', { class: 'small', text: say('collegeInjuries') }));
  if (!parts.length) return null;
  return h('section', { class: 'block', 'aria-labelledby': 'players-title' },
    h('h3', { id: 'players-title', class: 'section-label', text: say('players') }), parts);
}

function offseasonPlayers(t) {
  const o = t.offseason;
  return h('section', { class: 'block', 'aria-labelledby': 'players-title' },
    h('div', { class: 'block-head' }, h('h3', { id: 'players-title', class: 'section-label', text: `${say('leaders')}, ${o.resultsYear}` }), srcChip('mlb-leaders')),
    h('div', { class: 'leaders-grid' }, (o.leaders || []).map((L) => h('div', { class: 'lead-cell' },
      h('span', { class: 'cat', text: L.cat }), h('span', { class: 'val', text: L.value }), h('span', { class: 'who', text: L.name })))),
    h('div', { class: 'block-head' }, h('h3', { class: 'section-label', text: say('moves') }), srcChip('mlb-transactions')),
    o.moves?.length
      ? h('ul', { class: 'moves' }, o.moves.slice(0, 10).map((m) => h('li', {}, h('time', { datetime: m.date, text: fmtMD(noonET(m.date)) }), h('span', { text: m.text }))))
      : h('p', { class: 'small', text: 'No moves in the last 45 days.' }));
}

function linksBlock(n) {
  const links = [];
  if (n.headline?.url) links.push(h('a', { href: n.headline.url, target: '_blank', rel: 'noopener', text: `ESPN preview: ${n.headline.text}` }));
  else if (n.headline) links.push(h('span', { text: `ESPN preview: ${n.headline.text}` }));
  if (n.link) links.push(h('a', { href: n.link, target: '_blank', rel: 'noopener', text: 'Game page on ESPN' }));
  return links.length ? h('div', { class: 'links block' }, links) : null;
}

// ---------------------------------------------------------------- season

function pill(text) {
  return text ? h('span', { class: 'pill', text }) : null;
}

function seasonCard(t) {
  const me = t.standing?.rows?.find((r) => r.isPgh);
  const rank = t.standing?.rank;
  const diffWord = { baseball: 'Run', hockey: 'Goal', football: 'Point' }[t.sport];
  return h('aside', { class: 'card season', 'aria-labelledby': 'season-title' },
    h('div', { class: 'block-head' },
      h('h2', { id: 'season-title', class: 'section-label', text: [say('season'), t.seasonLabel, t.phase === 'offseason' ? 'final' : null].filter(Boolean).join(' · ') }),
      srcChip(t.key === 'pirates' ? 'mlb-standings' : `espn-schedule-${t.key}`)),
    h('div', { class: 'record-line' },
      h('span', { class: 'record-big', text: t.record?.summary || '—' }),
      h('div', { class: 'record-meta' },
        rank ? h('span', { class: 'rank', text: `${ord(rank)} in the ${t.standing.group}` }) : null,
        t.record?.pts != null ? h('span', { class: 'muted', text: `${t.record.pts} points in ${t.record.gp} games` }) : null)),
    h('div', { class: 'pills' },
      pill(t.record?.home && `Home ${t.record.home}`),
      pill(t.record?.road && `Road ${t.record.road}`),
      pill(me?.streak && `Streak ${me.streak}`),
      pill(me?.l10 && `Last 10 ${me.l10}`),
      pill(me?.diff != null && me.diff !== '' && `${diffWord} diff ${signed(me.diff)}`)),
    standingsBlock(t),
    chartBlock(t));
}

function standingsBlock(t) {
  const st = t.standing;
  if (!st?.rows?.length) return null;
  const oppId = t.next?.opp?.id;
  const cols = {
    nfl: [['Team', (r) => r.abbr], ['W', (r) => r.w], ['L', (r) => r.l], ['T', (r) => r.t, (rows) => rows.some((r) => r.t)], ['GB', (r) => r.gb], ['Diff', (r) => signed(r.diff)], ['Strk', (r) => r.streak]],
    nhl: [['Team', (r) => r.abbr], ['GP', (r) => r.gp], ['W', (r) => r.w], ['L', (r) => r.l], ['OTL', (r) => r.otl], ['PTS', (r) => r.pts], ['Strk', (r) => r.streak]],
    mlb: [['Team', (r) => r.abbr || r.name], ['W', (r) => r.w], ['L', (r) => r.l], ['GB', (r) => r.gb], ['WCGB', (r) => r.wcgb], ['Diff', (r) => signed(r.diff)]],
    conf: [['Team', (r) => r.name], ['Conf', (r) => r.conf], ['Overall', (r) => r.overall]],
  }[st.kind] || [];
  const use = cols.filter(([, , show]) => !show || show(st.rows));
  return h('div', { class: 'block' },
    h('div', { class: 'block-head' }, h('h3', { class: 'section-label', text: `${say('standings')} · ${st.group}` }), srcChip(st.sources?.[0])),
    h('div', { class: 'table-wrap' }, h('table', { class: 'standings' },
      h('thead', {}, h('tr', {}, use.map(([label]) => h('th', { scope: 'col', text: label })))),
      h('tbody', {}, st.rows.map((r) => h('tr', {
        class: [r.isPgh ? 'is-pgh' : '', oppId && String(r.id) === String(oppId) ? 'is-opp' : ''].join(' ').trim() || null,
      }, use.map(([, get]) => h('td', { text: get(r) ?? '—' }))))))));
}

function gameLine(g) {
  if (g.result) {
    const where = g.neutral && g.venue ? ` · ${g.venue.name}${g.venue.city ? `, ${g.venue.city}` : ''}` : '';
    return `${fmtDay(g.date)} · ${g.result} ${scoreText(g)}${g.extra ? ` ${g.extra}` : ''} ${vsAt(g)} ${g.opp.short || g.opp.name}${g.label ? ` · ${g.label}` : ''}${where}`;
  }
  return `${fmtDay(g.date)} · ${fmtTime(g.date)} ET · ${vsAt(g)} ${g.opp.short || g.opp.name}${g.label ? ` · ${g.label}` : ''}`;
}

// Charts are drawn at the holder's real pixel width, so labels stay 10px at any size.
let chartObserver = null;
function chartBlock(t) {
  const holder = h('div', { class: 'chart-holder' });
  const draw = () => {
    const W = Math.max(280, Math.round(holder.clientWidth));
    if (!holder.isConnected || holder.dataset.w === String(W)) return;
    holder.dataset.w = String(W);
    holder.replaceChildren(t.sport === 'baseball' ? paceChart(t, W) : marginChart(t, W));
  };
  chartObserver?.disconnect();
  chartObserver = new ResizeObserver(draw);
  chartObserver.observe(holder);
  return h('div', { class: 'block' },
    h('div', { class: 'block-head' },
      h('h3', { class: 'section-label', text: say('chart') }),
      srcChip(t.key === 'pirates' ? 'mlb-schedule' : `espn-schedule-${t.key}`)),
    holder);
}

function placeTip(wrap, tip, text, xFrac, yFrac) {
  tip.textContent = text;
  tip.hidden = false;
  const w = wrap.clientWidth;
  const left = Math.max(0, Math.min(w - tip.offsetWidth, xFrac * w - tip.offsetWidth / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(0, yFrac * wrap.clientHeight - 6)}px`;
}

function marginChart(t, W) {
  const games = t.games || [];
  const played = games.filter((g) => g.result && g.pf != null);
  const future = games.filter((g) => !g.result && g.state === 'pre');
  const slots = t.sport === 'football' ? [...played, ...future] : [...played.slice(-20), ...future.slice(0, 5)];
  if (!slots.length) return h('p', { class: 'small', text: 'No games yet.' });
  const H = 200;
  const m = { t: 12, r: 6, b: 30, l: 30 };
  const maxAbs = Math.max(1, ...played.map((g) => Math.abs(g.pf - g.pa)));
  const step = maxAbs <= 4 ? 1 : maxAbs <= 8 ? 2 : maxAbs <= 20 ? 5 : 10;
  const top = Math.ceil(maxAbs / step) * step;
  const y = (v) => m.t + ((top - v) / (2 * top)) * (H - m.t - m.b);
  const band = (W - m.l - m.r) / slots.length;
  const bw = Math.min(24, band * 0.66);
  const wrap = h('div', { class: 'chart-wrap' });
  const tip = h('div', { class: 'tip', hidden: true, role: 'presentation' });
  const note = h('p', { class: 'chart-note', 'aria-live': 'polite' });
  const svg = S('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'group', 'aria-label': `Final margin of each game. ${played.length} played, ${slots.length - played.length} upcoming shown.` });
  const ticks = [...new Set([top, Math.round(top / 2), 0, -Math.round(top / 2), -top])];
  for (const v of ticks) {
    svg.append(S('line', { class: v === 0 ? 'zero' : 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    svg.append(S('text', { x: m.l - 5, y: y(v) + 3, 'text-anchor': 'end', text: v === 0 ? '0' : signed(v) }));
  }
  const selected = slots.find((g) => g.id === ui.game);
  slots.forEach((g, i) => {
    const cx = m.l + band * (i + 0.5);
    const grp = S('g', { class: `slot${ui.game === g.id ? ' is-on' : ''}`, tabindex: '0', role: 'button', 'aria-label': gameLine(g), 'aria-pressed': String(ui.game === g.id) });
    grp.append(S('rect', { class: 'hit', x: cx - band / 2, y: m.t, width: band, height: H - m.t - 4, rx: 3 }));
    let topY = y(0) - 6;
    if (g.result) {
      const d = g.pf - g.pa;
      const y0 = y(Math.max(0, d));
      const y1 = y(Math.min(0, d));
      topY = y0;
      grp.append(S('rect', { class: `bar-${g.result}`, x: cx - bw / 2, y: y0, width: bw, height: Math.max(2, y1 - y0), rx: 2 }));
    } else {
      grp.append(S('rect', { class: 'future', x: cx - bw / 2, y: y(0) - 5, width: bw, height: 10, rx: 2 }));
    }
    const every = band >= 26 ? 1 : band >= 13 ? 2 : 3;
    if (i % every === 0) grp.append(S('text', { x: cx, y: H - m.b + 15, 'text-anchor': 'middle', text: g.opp.abbr }));
    const show = () => placeTip(wrap, tip, gameLine(g), cx / W, topY / H);
    grp.addEventListener('pointerenter', show);
    grp.addEventListener('focus', show);
    grp.addEventListener('pointerleave', () => { tip.hidden = true; });
    grp.addEventListener('blur', () => { tip.hidden = true; });
    const pick = () => { ui.game = ui.game === g.id ? null : g.id; renderTeam(); };
    grp.addEventListener('click', pick);
    grp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    svg.append(grp);
  });
  note.textContent = selected ? gameLine(selected) : '';
  const legend = h('div', { class: 'legend' },
    h('span', {}, h('i', { style: 'background:var(--win)' }), 'Win'),
    h('span', {}, h('i', { style: 'background:var(--loss)' }), 'Loss'),
    t.sport === 'hockey' ? h('span', {}, h('i', { style: 'background:var(--otl)' }), 'OT/SO loss') : null,
    future.length ? h('span', {}, h('i', { style: 'border:1px dashed var(--ink-3)' }), 'Upcoming') : null,
    h('span', { text: t.sport === 'hockey' ? 'Last 20 games and the next 5. Select a bar for details.' : 'Select a bar for details.' }));
  return append(wrap, [svg, tip, note, legend]);
}

function paceChart(t, W) {
  const played = (t.games || []).filter((g) => g.result);
  if (!played.length) return h('p', { class: 'small', text: 'No games yet.' });
  let w = 0;
  let l = 0;
  const pts = played.map((g, i) => {
    if (g.result === 'W') w++;
    else if (g.result === 'L') l++;
    return { i, v: w - l, w, l, g };
  });
  const H = 200;
  const m = { t: 14, r: 34, b: 26, l: 30 };
  const lo = Math.min(-5, ...pts.map((p) => p.v));
  const hi = Math.max(5, ...pts.map((p) => p.v));
  const x = (i) => m.l + (i / Math.max(1, pts.length - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);
  const wrap = h('div', { class: 'chart-wrap' });
  const tip = h('div', { class: 'tip', hidden: true, role: 'presentation' });
  const last = pts.at(-1);
  const svg = S('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Games above or below .500 across the season, finishing ${signed(last.v)} at ${last.w}-${last.l}.` });
  const stepV = hi - lo > 30 ? 10 : 5;
  for (let v = Math.ceil(lo / stepV) * stepV; v <= hi; v += stepV) {
    svg.append(S('line', { class: v === 0 ? 'zero' : 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    svg.append(S('text', { x: m.l - 5, y: y(v) + 3, 'text-anchor': 'end', text: v === 0 ? '.500' : signed(v) }));
  }
  let month = null;
  let lastX = -Infinity;
  for (const p of pts) {
    const mo = fmtMonth(p.g.date);
    if (mo === month) continue;
    month = mo;
    if (x(p.i) - lastX < 28) continue;
    lastX = x(p.i);
    svg.append(S('line', { class: 'grid', x1: x(p.i), x2: x(p.i), y1: H - m.b, y2: H - m.b + 4 }));
    svg.append(S('text', { x: x(p.i) + 2, y: H - m.b + 15, text: mo }));
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  svg.append(S('path', { class: 'pace-up', d: `${line} L${x(last.i).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z` }));
  svg.append(S('path', { class: 'pace-line', d: line }));
  svg.append(S('circle', { class: 'pace-dot', cx: x(last.i), cy: y(last.v), r: 4 }));
  svg.append(S('text', { x: x(last.i) + 6, y: y(last.v) + 3, text: signed(last.v) }));
  const cross = S('line', { class: 'cross', x1: 0, x2: 0, y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dot = S('circle', { class: 'pace-dot', r: 3.5, cx: 0, cy: 0, visibility: 'hidden' });
  const hit = S('rect', { class: 'hit', x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, tabindex: '0', role: 'slider', 'aria-label': 'Move through the season', 'aria-valuemin': '1', 'aria-valuemax': String(pts.length), 'aria-valuenow': String(pts.length) });
  let idx = pts.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[idx];
    cross.setAttribute('x1', x(p.i)); cross.setAttribute('x2', x(p.i)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(p.i)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible');
    hit.setAttribute('aria-valuenow', String(idx + 1));
    const text = `${fmtMD(p.g.date)} · ${p.w}-${p.l} (${p.v === 0 ? '.500' : signed(p.v)}) · ${p.g.result} ${scoreText(p.g)} ${vsAt(p.g)} ${p.g.opp.short}`;
    hit.setAttribute('aria-valuetext', text);
    placeTip(wrap, tip, text, x(p.i) / W, y(p.v) / H);
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    show(Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1)));
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(idx));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (d) { e.preventDefault(); show(idx + d); }
  });
  svg.append(cross, dot, hit);
  return append(wrap, [svg, tip, h('div', { class: 'legend', text: 'Games above or below .500. Hover, or focus and use the arrow keys, to move through the season.' })]);
}

// ---------------------------------------------------------------- city strip

function moodRows() {
  return TEAMS.map((tm) => {
    const t = state.teams[tm.key];
    if (!t || t.unavailable) return null;
    const last = (t.games || []).filter((g) => g.result).slice(-5);
    if (!last.length) return null;
    const pts = last.reduce((s, g) => s + (g.result === 'W' ? 1 : g.result === 'OTL' || g.result === 'T' ? 0.5 : 0), 0);
    return { key: tm.key, score: (pts / last.length) * 100, weight: t.phase === 'offseason' ? 0.5 : 1, results: last.map((g) => g.result) };
  }).filter(Boolean);
}

function moodCard() {
  const rows = moodRows();
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const score = total ? rows.reduce((s, r) => s + r.score * r.weight, 0) / total : null;
  const labels = say('moods');
  const label = score == null ? '' : labels[Math.min(4, Math.floor(score / 20))];
  const cx = 120;
  const cy = 122;
  const r = 96;
  const pt = (f) => [cx - r * Math.cos(Math.PI * f), cy - r * Math.sin(Math.PI * f)];
  const bands = ['var(--loss)', 'var(--otl)', 'var(--ink-3)', 'var(--gold)', 'var(--win)'];
  const gauge = S('svg', { class: 'gauge', viewBox: '0 0 240 140', role: 'img', 'aria-label': score == null ? 'City mood unavailable' : `City mood ${Math.round(score)} out of 100: ${label}` });
  bands.forEach((color, i) => {
    const [x0, y0] = pt(i / 5 + 0.008);
    const [x1, y1] = pt((i + 1) / 5 - 0.008);
    gauge.append(S('path', { d: `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`, fill: 'none', stroke: color, 'stroke-width': 16 }));
  });
  gauge.append(S('text', { x: cx - r, y: cy + 16, 'text-anchor': 'middle', text: '0' }), S('text', { x: cx + r, y: cy + 16, 'text-anchor': 'middle', text: '100' }));
  const target = (score ?? 0) * 1.8;
  const needle = S('line', { class: 'needle', x1: cx, y1: cy, x2: cx - (r - 24), y2: cy, style: `transform-origin:${cx}px ${cy}px;transform:rotate(${moodAngle}deg)` });
  gauge.append(needle, S('circle', { class: 'hub', cx, cy, r: 6 }));
  requestAnimationFrame(() => requestAnimationFrame(() => { needle.style.transform = `rotate(${target}deg)`; }));
  moodAngle = target;
  return h('section', { class: 'card', 'aria-labelledby': 'mood-title' },
    h('div', { class: 'block-head' }, h('h2', { id: 'mood-title', class: 'section-label', text: say('mood') }), h('span', { class: 'badge', text: 'Last 5 games each' })),
    gauge,
    h('div', { class: 'mood-score' }, h('span', { class: 'big', text: score == null ? '—' : String(Math.round(score)) }), h('span', { class: 'label', text: label })),
    h('ul', { class: 'mood-teams' }, rows.map((row) => h('li', { class: `team-${row.key}` },
      h('span', { text: nick(row.key) }),
      h('span', { class: 'track', title: row.results.join(' ') }, h('span', { class: 'fill', style: `width:${row.score}%` })),
      h('span', { class: 'v', text: `${Math.round(row.score)}${row.weight < 1 ? '*' : ''}` })))),
    h('details', {},
      h('summary', { text: say('moodHow') }),
      h('p', { class: 'small', text: "Each team's last five results score 1 for a win and ½ for an overtime loss or tie, as a percentage. A team in its offseason (*) counts half. The city number is the weighted average, so it moves after every final." })));
}

// Venue coordinates and a schematic of the three rivers near the Point.
const VENUES = [
  { name: 'Acrisure Stadium', lat: 40.4468, lon: -80.0158, teams: ['steelers', 'pitt'], label: { dx: -22, dy: -10, anchor: 'end' } },
  { name: 'PNC Park', lat: 40.4469, lon: -80.0057, teams: ['pirates'], label: { dx: 12, dy: -10, anchor: 'start' } },
  { name: 'PPG Paints Arena', lat: 40.4395, lon: -79.9893, teams: ['penguins'], label: { dx: 0, dy: 22, anchor: 'middle' } },
];
const RIVERS = [
  { name: 'Ohio River', width: 22, labelAt: 2, side: -1, pts: [[-80.0125, 40.4418], [-80.0175, 40.4440], [-80.0232, 40.4463], [-80.0290, 40.4487], [-80.0345, 40.4523], [-80.0400, 40.4575]] },
  { name: 'Allegheny River', width: 15, labelAt: 6, side: 1, pts: [[-80.0125, 40.4418], [-80.0088, 40.4440], [-80.0040, 40.4452], [-79.9990, 40.4463], [-79.9940, 40.4477], [-79.9885, 40.4503], [-79.9825, 40.4540], [-79.9765, 40.4585]] },
  { name: 'Monongahela River', width: 17, labelAt: 4, side: 1, pts: [[-80.0125, 40.4418], [-80.0088, 40.4392], [-80.0040, 40.4367], [-79.9985, 40.4345], [-79.9925, 40.4320], [-79.9862, 40.4296], [-79.9790, 40.4280], [-79.9740, 40.4274]] },
];
const BOUNDS = { w: -80.032, e: -79.976, s: 40.4265, n: 40.4585 };

function nextHomeAt(venue) {
  const now = Date.now();
  return venue.teams.flatMap((key) => {
    const t = state.teams[key];
    if (!t || t.unavailable) return [];
    const od = t.offseason?.openingDay;
    if (od) return od.home ? [{ key, at: etMidnight(od.day), day: od.day, opp: od.opp, label: 'Opening Day' }] : [];
    const g = (t.games || []).find((x) => x.state !== 'post' && x.home && !x.neutral && Date.parse(x.date) > now - 4 * 36e5);
    return g ? [{ key, at: g.date, opp: g.opp }] : [];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function mapCard() {
  const W = 400;
  const H = 300;
  const px = ([lon, lat]) => [((lon - BOUNDS.w) / (BOUNDS.e - BOUNDS.w)) * W, ((BOUNDS.n - lat) / (BOUNDS.n - BOUNDS.s)) * H];
  const svg = S('svg', { class: 'map', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Schematic map of the three rivers with the four home venues' });
  for (const river of RIVERS) {
    const p = river.pts.map(px);
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2;
      const my = (p[i][1] + p[i + 1][1]) / 2;
      d += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    d += ` L${p.at(-1)[0].toFixed(1)} ${p.at(-1)[1].toFixed(1)}`;
    svg.append(S('path', { class: 'river', d, 'stroke-width': river.width }));
  }
  for (const river of RIVERS) {
    const p = river.pts.map(px);
    const a = p[river.labelAt - 1];
    const b = p[river.labelAt];
    let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (-(b[1] - a[1]) / len) * (river.width / 2 + 7) * river.side;
    const ny = ((b[0] - a[0]) / len) * (river.width / 2 + 7) * river.side;
    const mx = (a[0] + b[0]) / 2 + nx;
    const my = (a[1] + b[1]) / 2 + ny;
    svg.append(S('text', { class: 'river-label', x: mx.toFixed(1), y: my.toFixed(1), 'text-anchor': 'middle', transform: `rotate(${ang.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})`, text: river.name }));
  }
  const area = (lon, lat, text) => {
    const [x, y] = px([lon, lat]);
    svg.append(S('text', { class: 'area-label', x, y, 'text-anchor': 'middle', text }));
  };
  area(-79.9972, 40.4396, say('downtown'));
  area(-80.0108, 40.4515, say('northShore'));
  area(-80.0072, 40.4412, say('point'));
  for (const v of VENUES) {
    const [x, y] = px([v.lon, v.lat]);
    v.teams.forEach((key, i) => {
      const dx = v.teams.length > 1 ? (i - (v.teams.length - 1) / 2) * 16 : 0;
      const label = `${nick(key)} at ${v.name}`;
      const pin = S('g', { class: `pin team-${key}`, tabindex: '0', role: 'button', 'aria-label': `Show ${label}` },
        S('circle', { cx: x + dx, cy: y, r: 8, fill: 'var(--tc)' }));
      pin.addEventListener('click', () => selectTeam(key, true));
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTeam(key, true); } });
      svg.append(pin);
    });
    svg.append(S('text', { class: 'venue-label', x: x + v.label.dx, y: y + v.label.dy, 'text-anchor': v.label.anchor, text: v.name }));
  }
  const items = VENUES.map((v) => {
    const next = nextHomeAt(v);
    return h('li', {},
      h('b', { text: v.name }),
      next.length
        ? h('span', { text: next.slice(0, 2).map((e) => `${nick(e.key)} vs ${e.opp.short || e.opp.name}, ${e.day ? fmtDay(noonET(e.day)) : fmtDay(e.at)}${e.label ? ` (${e.label})` : ''}`).join(' · then ') })
        : h('span', { class: 'muted', text: 'No home date on the schedule' }));
  });
  return h('section', { class: 'card', 'aria-labelledby': 'map-title' },
    h('div', { class: 'block-head' }, h('h2', { id: 'map-title', class: 'section-label', text: say('map') }), h('span', { class: 'badge', text: 'Next home dates' })),
    svg,
    h('ul', { class: 'venues' }, items),
    h('p', { class: 'small muted', text: 'Schematic. River lines are approximate; select a pin to open that team.' }));
}

const ROUND = { 1: 'first round', 2: 'second round', 3: 'conference final', 4: 'Stanley Cup Final' };

function clocksCard() {
  const hist = state.history || {};
  const rows = [];
  for (const tt of titles?.titles || []) {
    const latest = tt.latest ? hist[tt.latest] : null;
    rows.push({
      key: tt.team, since: etMidnight(tt.date), date: tt.date, title: tt.event, what: tt.detail, href: tt.source,
      verified: latest ? `Newest champion in the feed: ${latest.abbr} (${latest.season ?? latest.year})` : null, src: latest?.sourceId,
    });
    if (tt.team === 'steelers' && hist.steelersLastPlayoffWin?.date) {
      const w = hist.steelersLastPlayoffWin;
      rows.push({ key: 'steelers', since: w.date, title: 'Last playoff win', what: `${fmtMDY(w.date)}, ${w.pf}-${w.pa} ${w.home ? 'vs' : 'at'} ${w.opp}`, src: w.sourceId });
    }
    if (tt.team === 'penguins' && hist.penguinsLastSeriesWin?.year) {
      const s = hist.penguinsLastSeriesWin;
      rows.push({ key: 'penguins', title: 'Last playoff series win', what: `${s.year} ${ROUND[s.round] || 'playoffs'} vs ${s.opp}`, text: `${s.year}`, src: s.sourceId });
    }
    if (tt.team === 'pirates' && hist.piratesLastPostseason?.date) {
      const p = hist.piratesLastPostseason;
      rows.push({ key: 'pirates', since: p.date, title: 'Last postseason game', what: `${fmtMDY(p.date)} ${p.label}: ${p.away} ${p.awayScore}, ${p.home} ${p.homeScore}`, src: p.sourceId });
    }
  }
  const daysText = (since) => `${((Date.now() - Date.parse(since)) / DAY).toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 })} days`;
  return h('section', { class: 'card', 'aria-labelledby': 'parade-title' },
    h('div', { class: 'block-head' }, h('h2', { id: 'parade-title', class: 'section-label', text: say('parade') }), h('span', { class: 'badge', text: 'Ticking' })),
    h('ul', { class: 'clocks' }, rows.map((r) => h('li', { class: `team-${r.key}` },
      h('span', { class: `chip team-${r.key}`, text: OUR_ABBR[r.key] }),
      h('span', { text: `${nick(r.key)} · ${r.title}` }),
      r.since ? h('span', { class: 'days', 'data-since': r.since, text: daysText(r.since) }) : h('span', { class: 'days', text: r.text }),
      h('span', { class: 'what' }, r.what, r.href ? ' · ' : null, r.href ? h('a', { href: r.href, target: '_blank', rel: 'noopener', text: 'source' }) : null),
      r.verified || r.src ? h('span', { class: 'verified' }, r.verified ? `${r.verified} ` : 'Checked against ', srcChip(r.src)) : null))),
    h('p', { class: 'small muted', text: 'Title dates are fixed and cited. The playoff lines and the newest champions come from the league feeds on each snapshot.' }));
}

function renderCity() {
  const root = document.getElementById('city');
  if (!state) return;
  root.replaceChildren(moodCard(), mapCard(), clocksCard());
}

// ---------------------------------------------------------------- sources

function renderSources() {
  const root = document.getElementById('sources');
  if (!state) return;
  const checks = state.checks || [];
  const ok = checks.filter((c) => c.agree).length;
  const warn = checks.filter((c) => !c.agree && c.severity !== 'info').length;
  const srcs = [...(state.sources || [])].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const failed = srcs.filter((s) => !s.ok).length;
  const open = document.getElementById('source-list')?.open;
  const where = (s) => (s.env === 'browser' ? 'your browser' : 'snapshot');
  root.replaceChildren(
    h('div', { class: 'block-head' },
      h('h2', { class: 'section-label', id: 'sources-title', text: say('sources') }),
      h('button', { type: 'button', class: 'linkbtn', onclick: () => refresh(), text: refreshing ? 'Refreshing…' : 'Refresh now' })),
    h('p', { class: 'small', text: `${ok} of ${checks.length} cross-checks agree${warn ? `; ${warn} disagree and are flagged below` : ''}. ${srcs.length} requests behind this view${failed ? `, ${failed} failed` : ', all answered'}. Every storyline and table links to the request it came from.` }),
    h('ul', { class: 'checks' }, checks.map((c) => {
      const s = c.agree ? 'ok' : c.severity === 'info' ? 'info' : 'warn';
      return h('li', {},
        h('span', { class: 'check-icon', 'data-s': s, role: 'img', 'aria-label': { ok: 'Agrees', info: 'Note', warn: 'Disagrees' }[s], text: { ok: 'OK', info: 'i', warn: '!' }[s] }),
        h('div', {},
          h('div', {}, `${c.label} `, h('span', { class: 'badge', text: c.independent ? 'two publishers' : 'same publisher' })),
          h('div', { class: 'check-vals', text: `${c.a.value} (${shortLabel(c.a.src)}) · ${c.b.value} (${shortLabel(c.b.src)})` }),
          c.note ? h('div', { class: 'small', text: c.note }) : null));
    })),
    h('details', { id: 'source-list', open: open || null },
      h('summary', { text: `All ${srcs.length} requests` }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'srctable' },
        h('thead', {}, h('tr', {}, ['Source', 'Request', 'Fetched (ET)', 'From', 'Status'].map((x) => h('th', { scope: 'col', text: x })))),
        h('tbody', {}, srcs.map((s) => h('tr', { 'data-id': s.id },
          h('td', { text: s.label }),
          h('td', { class: 'url' }, h('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.url.replace(/^https?:\/\//, '') })),
          h('td', { class: 'num', text: `${fmtMD(s.at)}, ${fmtTime(s.at)}` }),
          h('td', { text: where(s) }),
          h('td', { class: s.ok ? null : 'bad', text: s.ok ? 'OK' : s.error || 'failed' }))))))));
}

// ---------------------------------------------------------------- clock, refresh, boot

function tick() {
  const now = Date.now();
  document.getElementById('clock').textContent = `${fmtClock(now)} ET`;
  const status = document.getElementById('status');
  let label = say('loading');
  if (mode === 'live') label = `${say('live')} · updated ${ago(now - liveAt)}`;
  else if (mode === 'snapshot' && state) label = `${say('snapshot')} · ${fmtTime(state.generatedAt)} ET`;
  else if (mode === 'offline') label = say('offline');
  if (status.dataset.label !== `${mode}|${label}`) {
    status.dataset.label = `${mode}|${label}`;
    status.replaceChildren(h('span', { class: `dot ${mode}`, 'aria-hidden': 'true' }), h('span', { text: label }));
  }
  for (const el of document.querySelectorAll('[data-countdown]')) el.textContent = countdown(Date.parse(el.dataset.countdown) - now);
  for (const el of document.querySelectorAll('[data-since]')) {
    el.textContent = `${((now - Date.parse(el.dataset.since)) / DAY).toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 })} days`;
  }
}

function applyWords() {
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = say(el.dataset.t);
  document.getElementById('yinzer').setAttribute('aria-pressed', String(ui.yinzer));
  document.documentElement.lang = 'en';
}

function render() {
  applyWords();
  renderUpNext();
  renderTabs();
  renderTeam();
  renderCity();
  renderSources();
  tick();
}

async function refresh() {
  clearTimeout(pollTimer);
  if (refreshing) return;
  if (document.hidden) {
    pollTimer = setTimeout(refresh, POLL_MS);
    return;
  }
  refreshing = true;
  try {
    const fresh = await buildAll({ env: 'browser', base: state });
    if (Object.values(fresh.teams).some((t) => !t.unavailable && !t.stale)) {
      state = fresh;
      mode = 'live';
      liveAt = Date.now();
    } else if (!state) {
      mode = 'offline';
    }
  } catch (err) {
    console.warn('Live refresh failed', err);
    if (!state) mode = 'offline';
  } finally {
    refreshing = false;
  }
  render();
  const anyLive = state && Object.values(state.teams).some((t) => t.live);
  pollTimer = setTimeout(refresh, anyLive ? LIVE_POLL_MS : POLL_MS);
}

async function boot() {
  ui.yinzer = pref('yinzer') === '1';
  const fromHash = location.hash.slice(1);
  if (TEAMS.some((t) => t.key === fromHash)) ui.team = fromHash;
  document.getElementById('yinzer').addEventListener('click', () => {
    ui.yinzer = !ui.yinzer;
    pref('yinzer', ui.yinzer ? '1' : '0');
    render();
  });
  window.addEventListener('hashchange', () => {
    const key = location.hash.slice(1);
    if (key !== ui.team && TEAMS.some((t) => t.key === key)) selectTeam(key);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - liveAt > 2 * 60e3) refresh();
  });
  setInterval(tick, 1000);
  applyWords();
  tick();
  const [snap, hist] = await Promise.all([getJSON('data/snapshot.json'), getJSON('data/history.json')]);
  titles = hist;
  if (snap?.teams) {
    state = snap;
    mode = 'snapshot';
    render();
  }
  await refresh();
}

boot();
