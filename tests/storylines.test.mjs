// Run with `node --test tests/*.test.mjs`. The first two tests read the snapshot that
// scripts/build-snapshot.mjs just wrote; the rest use small fixed inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storylines, brightSide } from '../assets/storylines.js';
import { computeChecks, parseRecord } from '../assets/feeds.js';

const state = JSON.parse(await readFile(new URL('../data/snapshot.json', import.meta.url), 'utf8'));
const fetched = new Set(state.sources.map((s) => s.id));

test('every storyline cites a request that was made, and reads cleanly', () => {
  for (const team of Object.values(state.teams)) {
    if (team.unavailable) continue;
    for (const line of storylines(team, state)) {
      assert.ok(line.sources.length, `${team.key}/${line.id} cites nothing`);
      for (const id of line.sources) assert.ok(fetched.has(id), `${team.key}/${line.id} cites ${id}, which was never fetched`);
      assert.doesNotMatch(line.text, /undefined|NaN|null|\[object/, `${team.key}/${line.id}: ${line.text}`);
    }
  }
});

test('every Brightside stat cites a request that was made, and reads cleanly', () => {
  for (const team of Object.values(state.teams)) {
    if (team.unavailable) continue;
    for (const line of brightSide(team, state)) {
      assert.equal(line.tone, 'good', `${team.key}/${line.id} is not good news`);
      assert.ok(line.sources.length, `${team.key}/${line.id} cites nothing`);
      for (const id of line.sources) assert.ok(fetched.has(id), `${team.key}/${line.id} cites ${id}, which was never fetched`);
      assert.doesNotMatch(line.text, /undefined|NaN|null|\[object/, `${team.key}/${line.id}: ${line.text}`);
    }
  }
});

test('every cross-check names sources that were fetched', () => {
  for (const c of computeChecks(state)) {
    assert.ok(fetched.has(c.a.src) && fetched.has(c.b.src), `${c.label} cites ${c.a.src} / ${c.b.src}`);
  }
});

// A minimal football team whose next game is Friday, Nov 13, 2026 at 7 PM ET.
function football({ name = 'Pitt', say = 'Pitt', league = 'NCAAF', lastGame = '2026-10-31T19:00Z', oppLast = '2026-10-31T19:00Z' } = {}) {
  return {
    key: 'pitt', name, say, league, sport: 'football',
    games: [{ id: '1', date: lastGame, result: 'W', pf: 20, pa: 10, state: 'post', home: true, opp: { id: '9', abbr: 'GT', say: 'Georgia Tech' } }],
    standing: {
      group: 'ACC', kind: 'conf', rank: 2, sources: ['s'],
      rows: [
        { id: '1', isPgh: true, conf: '3-3', cw: 3, cl: 3 },
        { id: '2', conf: '1-4', cw: 1, cl: 4 },
      ],
    },
    next: {
      id: '2', date: '2026-11-14T00:00Z', home: true, neutral: false, conference: true, sources: ['p'],
      opp: { id: '2', abbr: 'FSU', short: 'Florida State', say: 'Florida State' },
      form: { pgh: [{ r: 'W', score: '20-10', date: lastGame }], opp: [{ r: 'L', score: '20-10', date: oppLast }] },
      broadcasts: ['ESPN'],
    },
  };
}

test('Friday the 13th is noticed', () => {
  const lines = storylines(football(), {});
  assert.ok(lines.some((l) => l.id === 'quirk' && /Friday the 13th/.test(l.text)));
});

test('schools take singular verbs, pro teams plural', () => {
  const pitt = storylines(football(), {}).find((l) => l.id === 'stakes');
  assert.match(pitt.text, /Pitt is 3-3/);
  assert.match(pitt.text, /Florida State is 1-4/);
});

test('a bye shows up as rest, and shared byes are called out', () => {
  const both = storylines(football(), {}).find((l) => l.id === 'rest');
  assert.match(both.text, /Both teams are coming off a bye/);
  const ours = storylines(football({ oppLast: '2026-11-07T19:00Z' }), {}).find((l) => l.id === 'rest');
  assert.match(ours.text, /^Coming off the bye: 13 days/);
});

test('NFL division gaps are counted in half games', () => {
  const t = football({ name: 'Steelers', say: 'the Steelers', league: 'NFL' });
  t.standing = { group: 'AFC North', kind: 'nfl', rank: 1, sources: ['s'], rows: [{ id: '1', isPgh: true, w: 6, l: 2, t: 0 }, { id: '2', w: 5, l: 2, t: 0 }] };
  t.next.opp = { id: '2', abbr: 'CIN', short: 'Bengals', say: 'the Bengals' };
  const line = storylines(t, {}).find((l) => l.id === 'stakes');
  assert.equal(line.text, 'First place on the line: the Steelers (6-2) lead the Bengals by a half game in the AFC North.');
});

test('records parse with and without overtime losses', () => {
  assert.deepEqual(parseRecord('5-9-2'), { w: 5, l: 9, x: 2 });
  assert.deepEqual(parseRecord('82-80'), { w: 82, l: 80, x: 0 });
  assert.equal(parseRecord(''), null);
});

test('Brightside counts streaks, splits and margin from the games', () => {
  const t = football({ name: 'Steelers', say: 'the Steelers', league: 'NFL' });
  const g = (id, date, result, pf, pa, home) => ({ id, date, result, pf, pa, home, neutral: false, state: 'post', opp: { id: '9', abbr: 'X', say: 'X' } });
  t.key = 'steelers';
  t.games = [
    g('1', '2026-09-13T17:00Z', 'L', 10, 20, false),
    g('2', '2026-09-20T17:00Z', 'W', 24, 10, true),
    g('3', '2026-09-27T17:00Z', 'W', 21, 20, true),
    g('4', '2026-10-04T17:00Z', 'W', 30, 3, true),
  ];
  t.standing = { group: 'AFC North', kind: 'nfl', rank: 1, sources: ['s'], rows: [] };
  const lines = brightSide(t, {});
  const text = (id) => lines.find((l) => l.id === id)?.text;
  assert.equal(text('streak'), 'The Steelers have won three straight.');
  assert.equal(text('top'), 'The Steelers are first in the AFC North.');
  assert.equal(text('over500'), 'The Steelers are 3-1, two games over .500.');
  assert.equal(text('margin'), 'The Steelers have outscored opponents by 32 points this season.');
  assert.equal(text('home'), 'Unbeaten at home this season: 3-0.');
  assert.equal(text('best-run'), undefined, 'the current streak is the best run, so it is not repeated');
  assert.ok(lines.every((l) => l.sources.length && l.tone === 'good'));
});

test('Brightside stays quiet for a losing team', () => {
  const t = football();
  t.games = [{ id: '1', date: '2026-10-31T19:00Z', result: 'L', pf: 3, pa: 30, state: 'post', home: true, opp: { id: '9' } }];
  t.standing.rank = 9;
  t.next.form.pgh = [{ r: 'L', score: '3-30', date: '2026-10-31T19:00Z' }];
  t.next.opp.id = '99';
  const ids = brightSide(t, {}).map((l) => l.id);
  assert.ok(!ids.some((id) => ['streak', 'over500', 'margin', 'home', 'top'].includes(id)), ids.join(','));
});
