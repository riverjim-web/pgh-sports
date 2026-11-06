# Pittsburgh Sports Dashboard

Static site on GitHub Pages: plain HTML, CSS and ES modules, no build step, no dependencies.

## Layout

- `assets/feeds.js` fetches and normalizes every feed into one state object. The same code runs in Node (the snapshot) and in the browser (live refresh). Every request goes through `ctx.get(id, label, url)` so the page can cite it.
- `assets/storylines.js` holds the storyline rules. Each rule returns a sentence plus the source ids it rests on. Never hard-code a sentence about a specific game.
- `assets/app.js` is the UI (plain DOM, no framework), with `assets/style.css` and `index.html`.
- `scripts/build-snapshot.mjs` writes `data/snapshot.json`. `.github/workflows/deploy.yml` runs it every 30 minutes, then tests and deploys Pages.
- `data/history.json` holds the fixed, cited championship dates.

## Feed gotchas (checked November 2026)

- ESPN (`site.api.espn.com`): the schedule, summary, standings and scoreboard endpoints allow browser requests; the `/teams/{id}` page does not, so it is fetched in Node only.
- The NHL's own API (`api-web.nhle.com`) sends no CORS headers, so it is Node only. The browser carries `team.official` over from the snapshot (`mergeSnapshot`).
- ESPN's team page drops NHL overtime losses from its record string ("5-9" vs "5-9-2"). Use the schedule's `team.recordSummary`.
- MLB statsapi reports postponed games with `abstractGameState: "Final"`. Filter on `detailedState`.
- Take rosters, coaches and records from the feeds, never from memory.

## Commands

- `npm run snapshot` refreshes `data/snapshot.json` (needs Node 20+).
- `npm test` checks that every storyline cites a fetched request, plus the rule unit tests.
- `npm run serve` or `python3 -m http.server 8080`, then open http://localhost:8080.
- Run git here in WSL. Pushing to `main` redeploys the site.
