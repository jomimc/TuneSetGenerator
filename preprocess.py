"""
Preprocessing script for TuneSetGenerator.

Downloads tunes.json from TheSession-data GitHub repo, parses each tune,
extracts incipits (first 3 bars, or 4 if the tune opens with a pickup),
and saves:

  data/tunes/{tune_id}.json       individual full-tune files
  data/incipits/{tune_id}.json    individual incipit files
  data/incipits.json              combined incipits keyed by tune_id

It also builds the popularity/set datasets that power the non-random
"choose by popularity" modes (deployed, committed to the repo):

  data/popularity.json     tune_id -> number of tunebook adds
  data/user_sets.json      popular user-saved sets (exact ordered, count>=2)
  data/recorded_sets.json  recorded medleys (exact ordered, count>=1)
"""
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib
matplotlib.use('Agg')  # headless backend (no display needed)
import matplotlib.pyplot as plt
import numpy as np

import pyabc


# ─── Download ──────────────────────────────────────────────────────

TUNES_URL = ('https://raw.githubusercontent.com/adactio/TheSession-data/'
             'main/json/tunes.json')
# sets.json is stored with Git LFS, so it must be fetched from the media host
# (the plain raw URL returns a small LFS pointer file).
SETS_URL = ('https://media.githubusercontent.com/media/adactio/'
            'TheSession-data/main/json/sets.json')
RECORDINGS_URL = ('https://raw.githubusercontent.com/adactio/TheSession-data/'
                  'main/json/recordings.json')
POPULARITY_URL = ('https://raw.githubusercontent.com/adactio/TheSession-data/'
                  'main/json/tune_popularity.json')

# Minimum number of independent occurrences for a set to be kept.
# User sets: a set two+ users saved is "popular"; one-offs are personal noise.
# Recordings: a single recording is already a curated medley, so keep all.
USER_SET_MIN_COUNT = 2
RECORDED_SET_MIN_COUNT = 1

# Sets longer than this are dropped (the app caps set size at 5, and longer
# medleys are rare and unwieldy).
MAX_SET_SIZE = 5

# Popularity options shown in the UI, per source. "Top X%" is rank-based: the
# X% most popular items (so popular items still appear in the more adventurous,
# larger pools). Recordings use explicit count ranges instead, since their
# occurrence counts barely vary (mostly 1).
TOP_PCT = {
    'tunes':    [50, 25, 10, 5, 1],
    'usersets': [40, 10, 5, 1],
}
REC_RANGES = [(1, 1), (2, 10), (11, None)]


def download(url, dest):
    """Download url to dest, skipping if the file already exists (cache)."""
    if Path(dest).exists():
        print(f'Using cached {dest}')
        return
    print(f'Downloading {url} ...')
    urllib.request.urlretrieve(url, dest)
    print('Done.')


def download_tunes(dest='tunes.json'):
    download(TUNES_URL, dest)


# ─── Helpers (from automated_checks.py) ───────────────────────────

def parse_meter_duration(txt):
    """Meter string -> duration in quarter-note units.
       '4/4' -> 4.0,  '6/8' -> 3.0,  '9/8' -> 4.5
    """
    if txt == 'C':
        return 4.0
    if txt.startswith('M:'):
        txt = txt[2:].strip()
    num, denom = txt.split('/')
    return 4 * float(num) / float(denom)


def get_unit_note_length(meter_str):
    """Default unit note length in quarter-note units, per ABC spec.
       M >= 3/4 -> L:1/8 -> 0.5;  M < 3/4 -> L:1/16 -> 0.25
    """
    try:
        num, denom = meter_str.split('/')
        return 0.25 if float(num) / float(denom) < 0.75 else 0.5
    except Exception:
        return 0.5


def remove_unnecessary_elements(abc):
    """Strip slurs and pauses that can trip up the parser."""
    for ch in ')H':
        abc = abc.replace(ch, '')
    if '(' not in abc:
        return abc
    # Keep tuplet markers (3, (5, etc. but remove slur parens
    if re.search(r'\([2-9]', abc):
        out, start = [], 0
        for m in re.finditer(r'\(', abc):
            if m.end() < len(abc) and abc[m.end()] in '23456789':
                continue
            out.append((start, m.start()))
            start = m.end()
        out.append((start, len(abc)))
        return ''.join(abc[a:b] for a, b in out)
    return abc.replace('(', '')


def token_duration(tok):
    """Duration in unit-note-length multiples for a Note or Rest."""
    if isinstance(tok, pyabc.Note):
        return tok.duration
    if isinstance(tok, pyabc.Rest):
        n = int(tok.length[0]) if tok.length[0] is not None else 1
        d = int(tok.length[1]) if tok.length[1] is not None else 1
        return n / d
    return 0


# ─── Incipit extraction (adapted from checks_final.py) ────────────

def extract_incipit(tune, meter_str):
    """
    Return the ABC text of the first 3 bars of a tune.
    If the first bar is a pickup (anacrusis), return 4 bars instead.

    A pickup is detected when the cumulative note/rest duration in the
    first bar is shorter than the expected meter duration (same logic
    as count_beats_in_measure from checks_final.py, applied only to
    bar 0).
    """
    expected = parse_meter_duration(meter_str)
    unit = get_unit_note_length(meter_str)

    # --- pass 1: detect pickup ---
    cumulative = 0.0
    has_notes = False
    is_pickup = False

    for tok in tune.tokens:
        if isinstance(tok, (pyabc.Note, pyabc.Rest)):
            cumulative += token_duration(tok) * unit
            has_notes = True
        elif isinstance(tok, pyabc.Beam):
            if has_notes:
                is_pickup = cumulative < (expected - 0.001)
                break

    n_bars = 4 if is_pickup else 3

    # --- pass 2: collect token text for first n_bars ---
    parts = []
    bars_closed = 0
    bar_has_notes = False

    for tok in tune.tokens:
        if isinstance(tok, pyabc.Beam):
            parts.append(tok._text)
            if bar_has_notes:
                bars_closed += 1
                if bars_closed >= n_bars:
                    break
            bar_has_notes = False
        elif isinstance(tok, pyabc.Newline):
            pass  # flatten to single line
        elif isinstance(tok, pyabc.BodyField):
            parts.append(tok._text + '\n')  # field stays on its own line
        else:
            if isinstance(tok, (pyabc.Note, pyabc.Rest)):
                bar_has_notes = True
            parts.append(tok._text)

    return ''.join(parts)


# ─── Chunk helpers ─────────────────────────────────────────────────

CHUNK_SIZE = 1000  # tune IDs per chunk file


def chunk_id(tune_id):
    return int(tune_id) // CHUNK_SIZE


def save_chunks(data_by_tid, out_dir):
    """Group {tune_id: data} into chunk files: out_dir/0.json, 1.json, ..."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    chunks = {}
    for tid, data in data_by_tid.items():
        cid = chunk_id(tid)
        if cid not in chunks:
            chunks[cid] = {}
        chunks[cid][tid] = data
    for cid, chunk_data in chunks.items():
        with open(f'{out_dir}/{cid}.json', 'w', encoding='utf-8') as f:
            json.dump(chunk_data, f, ensure_ascii=False, separators=(',', ':'))
    return len(chunks)


# ─── Main pipeline ────────────────────────────────────────────────

def process(tunes_path='tunes.json'):
    print('Loading tunes.json ...')
    with open(tunes_path, encoding='utf-8') as f:
        entries = json.load(f)
    print(f'  {len(entries)} settings loaded.')

    # Keep original (lowest setting_id) setting per tune
    by_id = {}
    for e in entries:
        tid = e['tune_id']
        if tid not in by_id or int(e['setting_id']) < int(by_id[tid]['setting_id']):
            by_id[tid] = e
    print(f'  {len(by_id)} unique tunes.')

    all_incipits = {}
    all_tunes = {}
    errors = []
    total = len(by_id)

    for i, (tid, entry) in enumerate(by_id.items()):
        if (i + 1) % 2000 == 0 or i + 1 == total:
            sys.stdout.write(f'\r  Processing {i+1}/{total} ...')
            sys.stdout.flush()

        meta = {
            'name':  entry['name'],
            'type':  entry['type'],
            'meter': entry['meter'],
            'mode':  entry['mode'],
        }

        # ── full tune ──
        abc_full = entry['abc'].replace('\r\n', '\n').strip()
        all_tunes[tid] = {**meta, 'abc': abc_full}

        # ── incipit ──
        try:
            clean_abc = remove_unnecessary_elements(entry['abc'])
            clean_entry = dict(entry, abc=clean_abc)
            tune_obj = pyabc.Tune(json=clean_entry)
            abc_inc = extract_incipit(tune_obj, entry['meter'])
        except Exception as ex:
            errors.append((tid, entry['name'], str(ex)))
            abc_inc = abc_full  # fallback: keep full ABC

        all_incipits[tid] = {**meta, 'abc': abc_inc}

    print()

    # ── Save combined files ──
    print('Saving combined files ...')
    Path('data').mkdir(exist_ok=True)

    with open('data/incipits.json', 'w', encoding='utf-8') as f:
        json.dump(all_incipits, f, ensure_ascii=False, separators=(',', ':'))
    with open('data/tunes.json', 'w', encoding='utf-8') as f:
        json.dump(all_tunes, f, ensure_ascii=False, separators=(',', ':'))

    inc_mb = Path('data/incipits.json').stat().st_size / 1024 / 1024
    tun_mb = Path('data/tunes.json').stat().st_size / 1024 / 1024
    print(f'  data/incipits.json: {inc_mb:.1f} MB')
    print(f'  data/tunes.json:    {tun_mb:.1f} MB')

    # ── Save chunked files ──
    print('Saving chunked files ...')
    n_inc = save_chunks(all_incipits, 'data/incipits')
    n_tun = save_chunks(all_tunes, 'data/tunes')
    print(f'  data/incipits/: {n_inc} chunk files')
    print(f'  data/tunes/:    {n_tun} chunk files')

    print(f'\nDone. {total} tunes processed, {len(errors)} errors.')
    if errors:
        print(f'First 5 errors:')
        for tid, name, msg in errors[:5]:
            print(f'  {tid} ({name}): {msg}')
        with open('data/errors.json', 'w') as f:
            json.dump([{'tune_id': t, 'name': n, 'error': e}
                       for t, n, e in errors], f, indent=2)

    # tune_id (int) -> rhythm type, used to tag sets below
    return {int(tid): meta['type'] for tid, meta in all_tunes.items()}


# ─── Popularity / set datasets ─────────────────────────────────────

def build_popularity(dest='data/popularity.json'):
    """tune_id (string) -> number of tunebook adds (int)."""
    download(POPULARITY_URL, 'tune_popularity.json')
    with open('tune_popularity.json', encoding='utf-8') as f:
        pop = json.load(f)
    out = {p['tune_id']: int(p['tunebooks']) for p in pop}
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  {dest}: {len(out)} tunes, '
          f'{Path(dest).stat().st_size / 1024:.0f} KB')


# How many example recording titles to attach to each recorded set.
REC_ALBUM_CAP = 6


def aggregate_sets(rows, group_key, order_key, min_count, types, album_of=None):
    """Group rows into ordered tune-id sequences and count duplicates.

    A "set" is the exact ordered sequence of tune_ids within a group.
    Groups outside the 2..MAX_SET_SIZE length range, or with any unmatched
    (empty) tune_id, are skipped. Returns a list of {t:[ids], n:count,
    r:rhythm} sorted by count descending, keeping only sequences seen
    >= min_count times. If `album_of(rows)` is given, a capped list of
    distinct recording titles is attached as `recs`.
    """
    groups = defaultdict(list)
    for r in rows:
        groups[group_key(r)].append(r)

    sig = Counter()
    albums = defaultdict(list)
    for rs in groups.values():
        rs.sort(key=lambda r: int(order_key(r)))
        ids = [r['tune_id'] for r in rs]
        if len(ids) < 2 or len(ids) > MAX_SET_SIZE or any(not i for i in ids):
            continue
        key = tuple(int(i) for i in ids)
        sig[key] += 1
        if album_of:
            title = album_of(rs)
            if title and title not in albums[key]:
                albums[key].append(title)

    out = []
    for t, c in sig.items():
        if c < min_count:
            continue
        entry = {'t': list(t), 'n': c, 'r': types.get(t[0], '')}
        if album_of:
            entry['recs'] = albums[t][:REC_ALBUM_CAP]
        out.append(entry)
    out.sort(key=lambda e: -e['n'])
    return out


def build_user_sets(types, dest='data/user_sets.json'):
    download(SETS_URL, 'sets.json')
    with open('sets.json', encoding='utf-8') as f:
        rows = json.load(f)
    sets = aggregate_sets(rows, lambda r: r['tuneset'],
                          lambda r: r['settingorder'],
                          USER_SET_MIN_COUNT, types)
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(sets, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  {dest}: {len(sets)} sets (count>={USER_SET_MIN_COUNT}), '
          f'{Path(dest).stat().st_size / 1024:.0f} KB')


def recording_label(rows):
    """\"Artist, Album\" for a recording-track group (either may be missing)."""
    artist = (rows[0].get('artist') or '').strip()
    album = (rows[0].get('recording') or '').strip()
    if artist and album:
        return artist + ', ' + album
    return artist or album


def build_recorded_sets(types, dest='data/recorded_sets.json'):
    download(RECORDINGS_URL, 'recordings.json')
    with open('recordings.json', encoding='utf-8') as f:
        rows = json.load(f)
    sets = aggregate_sets(rows, lambda r: (r['id'], r['track']),
                          lambda r: r['number'],
                          RECORDED_SET_MIN_COUNT, types,
                          album_of=recording_label)
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(sets, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  {dest}: {len(sets)} medleys (count>={RECORDED_SET_MIN_COUNT}), '
          f'{Path(dest).stat().st_size / 1024:.0f} KB')


# ─── Distribution plots (diagnostics) ─────────────────────────────

def rank_cutoff_value(values, pct):
    """Popularity value at the boundary of the top `pct` percent (rank-based):
    the value of the k-th most popular item, k = ceil(pct/100 * N)."""
    desc = np.sort(np.asarray(values))[::-1]
    k = int(np.ceil(pct / 100 * len(desc)))
    return int(desc[min(k, len(desc)) - 1])


def plot_distribution(values, lines, title, dest):
    """Histogram (log-log) + CDF with labelled vertical marker lines.
    `lines` is a list of (value, label) tuples."""
    arr = np.asarray(values)
    fig, (ax_h, ax_c) = plt.subplots(1, 2, figsize=(12, 4.5))
    cmap = plt.cm.viridis(np.linspace(0, 0.85, max(len(lines), 1)))

    lo = max(int(arr.min()), 1)
    bins = np.logspace(np.log10(lo), np.log10(arr.max() + 1), 40)
    ax_h.hist(arr, bins=bins, color='#bbb', edgecolor='#888')
    ax_h.set_xscale('log'); ax_h.set_yscale('log')
    ax_h.set_xlabel('popularity'); ax_h.set_ylabel('count (log)')
    ax_h.set_title(title + ' — histogram')

    srt = np.sort(arr)
    cdf = np.arange(1, len(srt) + 1) / len(srt)
    ax_c.plot(srt, cdf, color='#444'); ax_c.set_xscale('log')
    ax_c.set_xlabel('popularity'); ax_c.set_ylabel('cumulative fraction')
    ax_c.set_title(title + ' — CDF')

    for (val, lab), c in zip(lines, cmap):
        for ax in (ax_h, ax_c):
            ax.axvline(val, color=c, ls='--', lw=1.2)
        ax_h.text(val, ax_h.get_ylim()[1], f'{lab} (≥{val})', color=c,
                  rotation=90, va='top', ha='right', fontsize=8)

    fig.suptitle(f'{title} popularity distribution', fontsize=11)
    fig.tight_layout()
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(dest, dpi=110)
    plt.close(fig)
    print(f'  {dest}')


def build_plots(types):
    """Plot each source's popularity distribution with the UI cutoff lines."""
    pop = json.load(open('data/popularity.json', encoding='utf-8'))
    user_sets = json.load(open('data/user_sets.json', encoding='utf-8'))
    recorded = json.load(open('data/recorded_sets.json', encoding='utf-8'))

    tune_vals = [v for tid, v in pop.items() if int(tid) in types]
    us_vals = [s['n'] for s in user_sets]
    rec_vals = [s['n'] for s in recorded]

    print('Plotting popularity distributions ...')
    plot_distribution(
        tune_vals,
        [(rank_cutoff_value(tune_vals, p), f'Top {p}%') for p in TOP_PCT['tunes']],
        'tunes', 'plots/tunes.png')
    plot_distribution(
        us_vals,
        [(rank_cutoff_value(us_vals, p), f'Top {p}%') for p in TOP_PCT['usersets']],
        'user sets', 'plots/usersets.png')
    plot_distribution(
        rec_vals, [(1, 'once'), (2, '2–10'), (11, '10+')],
        'recorded sets', 'plots/recordings.png')

    for src, pcts in TOP_PCT.items():
        vals = tune_vals if src == 'tunes' else us_vals
        N = len(vals)
        sizes = {f'Top {p}%': int(np.ceil(p / 100 * N)) for p in pcts}
        print(f'    {src}: pool sizes {sizes}')
    for lo, hi in REC_RANGES:
        c = sum(1 for v in rec_vals if v >= lo and (hi is None or v <= hi))
        print(f'    recordings n in [{lo},{hi or "inf"}]: {c}')


def main():
    if not Path('tunes.json').exists():
        download_tunes()
    types = process()
    print('Building popularity / set datasets ...')
    build_popularity()
    build_user_sets(types)
    build_recorded_sets(types)
    build_plots(types)


if __name__ == '__main__':
    main()
