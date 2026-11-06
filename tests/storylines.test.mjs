// Run with `node --test tests/*.test.mjs`. The first two tests read the snapshot that
// scripts/build-snapshot.mjs just wrote; the rest use small fixed inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storylines } from '../assets/storylines.js';
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
