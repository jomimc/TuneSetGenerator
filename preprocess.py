"""
Preprocessing script for TuneSetGenerator.

Downloads tunes.json from TheSession-data GitHub repo, parses each tune,
extracts incipits (first 3 bars, or 4 if the tune opens with a pickup),
and saves:

  data/tunes/{tune_id}.json       individual full-tune files
  data/incipits/{tune_id}.json    individual incipit files
  data/incipits.json              combined incipits keyed by tune_id
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

import pyabc


# ─── Download ──────────────────────────────────────────────────────

def download_tunes(dest='tunes.json'):
    url = ('https://raw.githubusercontent.com/adactio/TheSession-data/'
           'main/json/tunes.json')
    print(f'Downloading {url} ...')
    urllib.request.urlretrieve(url, dest)
    print('Done.')


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


def main():
    if not Path('tunes.json').exists():
        download_tunes()
    process()


if __name__ == '__main__':
    main()
