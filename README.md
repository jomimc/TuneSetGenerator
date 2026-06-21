# Tune Set Generator

A static web app that helps Irish traditional musicians pick sets of tunes. It
runs entirely in the browser — no backend, no build step — and is deployed on
GitHub Pages.

**Live app:** https://jomimc.github.io/TuneSetGenerator/

## What it does

Pick a set of tunes one of five ways (the **Source** selector):

- **My tunebook** — random unique tunes from your thesession.org tunebook,
  grouped by rhythm, with Size (2–5) and Key-matching controls. Enter your
  member number to load and cache your tunebook; play with friends by adding
  more members (sets are drawn from the tunes you have in common).
- **My sets** — pick from your own saved sets on thesession.org (loaded for the
  primary member, like the tunebook).
- **Popular sets** — sets that other thesession.org users have saved, ranked by
  popularity. Optionally restricted to sets you fully know (every tune in your
  tunebook).
- **Recorded sets** — medleys as they appear on recordings; a details box shows
  example recordings they were taken from.
- **Popular tunes** — a fresh set sampled by how many tunebooks each tune
  appears in. Works **without loading a tunebook**, for players who haven't
  filled theirs in; with a tunebook loaded, can be limited to tunes you know.

The popularity sources share a **Popularity** control. For tunes and user sets
it offers cumulative **Top X%** pools (Top 50% / 25% / 10% / 5% / 1% for tunes;
Any / Top 40% / 10% / 5% / 1% for user sets) — the X% most popular items, sampled
uniformly, so well-known tunes still turn up occasionally even in the larger,
more adventurous pools. Recorded sets instead
offer occurrence-count ranges (Recorded once / 2–10 times / 10+ times). Each
option shows its candidate count on hover.

### Layout & defaults

The controls live in two collapsible sections — **Load tunebooks** and
**Settings** — both collapsed by default, so a first-time user can just press the
large **Pick** button and immediately get a set. The defaults (**Popular tunes /
size 3 / Any keys / Top 1%**) work with no tunebook and no thesession account.
The **My tunebook** / **My sets** sources stay disabled until a tunebook is
loaded.

The **Rhythm** selector shows how many sets/tunes are actually available for the
current settings, updating as you change Size, Keys, Popularity, or "only what I
know". Your choices (source, size, keys, popularity per source, and the
collapsed/expanded sections) are remembered between visits.

Tunes render as sheet music (incipits by default, full notation on toggle), are
drag-reorderable, link to thesession.org, and can be saved, marked played
(24-hour cooldown), and exported to `.xlsx`.

Don't know your number? Each member row can **search by name** or **search by
location** — type your name, type a town (geocoded via OpenStreetMap Nominatim),
or use your device location — then pick yourself from the list to load the
tunebook.

## Run it locally

The app is plain HTML/CSS/JS. Because it `fetch()`es JSON from `data/`, you must
serve it over HTTP — opening `index.html` as a `file://` URL will not work.

```bash
git clone https://github.com/jomimc/TuneSetGenerator.git
cd TuneSetGenerator
python3 -m http.server 8000
```

Then open http://localhost:8000/ in a browser. Any static file server works
(e.g. `npx serve`); Python 3's built-in server needs nothing installed.

All runtime dependencies (`abcjs`, `SortableJS`, `idb-keyval`, SheetJS) load
from CDNs, so the only thing you need locally is the server.

## Update the tune data (optional)

The committed JSON in `data/` is a preprocessed snapshot of the
[TheSession-data](https://github.com/adactio/TheSession-data) dump. To refresh
it, run the preprocessing script:

```bash
pip install -r requirements.txt   # numpy + matplotlib (for the bracket plots)
python3 preprocess.py
```

It downloads the source files, then regenerates:

| Output (committed) | Contents |
|---|---|
| `data/incipits.json` | Combined incipits keyed by tune ID |
| `data/tunes/*.json` | Chunked full-tune notation |
| `data/popularity.json` | Tune ID → number of tunebook adds |
| `data/user_sets.json` | Popular user-saved sets (count ≥ 2) |
| `data/recorded_sets.json` | Recorded medleys (count ≥ 1) |

It also writes diagnostic distribution plots to `plots/` (gitignored) showing
each source's popularity histogram/CDF with the bracket quantile lines, so you
can sanity-check the bracket boundaries.

The raw downloads (`tunes.json`, `sets.json`, `recordings.json`,
`tune_popularity.json`) are cached in the project root and **gitignored** — the
script skips re-downloading any that already exist. `sets.json` is ~130 MB
(stored with Git LFS in the data repo and fetched from `media.githubusercontent.com`);
the first run will take a while.

## Update the online version

GitHub Pages serves the site from the `master` branch, so deploying is just a
push:

```bash
git add -A
git commit -m "Describe your change"
git push origin master
```

GitHub Pages rebuilds automatically; the live site updates within a minute or
two (a hard refresh clears cached assets). There is no separate build or
`gh-pages` branch.

## Project structure

| Path | Purpose |
|---|---|
| `index.html` | Page structure and CDN script imports |
| `app.js` | All app logic: API, caching, set picking, rendering, events |
| `style.css` | Styling |
| `preprocess.py` | Builds the `data/` JSON from the TheSession-data dump |
| `pyabc.py` | ABC notation parser used by `preprocess.py` |
| `data/` | Preprocessed tune, incipit, popularity, and set data |

See `CLAUDE.md` for fuller implementation notes.
```
