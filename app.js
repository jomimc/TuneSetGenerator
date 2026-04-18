(function () {
  'use strict';

  // --- State ---
  let memberId = null;
  let tunebook = [];
  let currentSet = null; // {rhythm, tunes: [{id, name, type, url, key?, abc?}]}

  // --- IndexedDB via idb-keyval ---
  const store = idbKeyval.createStore('tunesetgen', 'cache');

  async function dbGet(key) { return idbKeyval.get(key, store); }
  async function dbSet(key, val) { return idbKeyval.set(key, val, store); }
  async function dbDel(key) { return idbKeyval.del(key, store); }

  // --- DOM refs ---
  const memberInput = document.getElementById('memberInput');
  const loadBtn = document.getElementById('loadBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const loadProgress = document.getElementById('loadProgress');
  const tunebookInfo = document.getElementById('tunebookInfo');
  const pickerSection = document.getElementById('picker-section');
  const rhythmSelect = document.getElementById('rhythmSelect');
  const pickBtn = document.getElementById('pickBtn');
  const saveBtn = document.getElementById('saveBtn');
  const setDisplay = document.getElementById('set-display');

  // --- Utility ---
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function pickRandomUnique(array, count) {
    const shuffled = array.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, count);
  }

  // --- Played-today tracking (localStorage) ---
  function getPlayedMap() {
    const raw = localStorage.getItem('played:' + memberId);
    return raw ? JSON.parse(raw) : {};
  }

  function setPlayedMap(map) {
    localStorage.setItem('played:' + memberId, JSON.stringify(map));
  }

  function markTunePlayed(tuneId) {
    const map = getPlayedMap();
    map[tuneId] = todayStr();
    setPlayedMap(map);
  }

  // --- API ---
  async function fetchTunebookFromAPI(mid) {
    const allTunes = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      loadProgress.textContent = totalPages > 1
        ? 'Fetching page ' + page + ' of ' + totalPages + '...'
        : 'Fetching tunebook...';

      const url = 'https://thesession.org/members/' + mid +
        '/tunebook?format=json&perpage=50&page=' + page;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('API error: ' + resp.status);
      const data = await resp.json();

      if (page === 1 && (!data.tunes || data.tunes.length === 0)) {
        throw new Error('No tunes found. Check the member number.');
      }

      totalPages = data.pages;
      allTunes.push(...data.tunes);
      page++;
    }

    await dbSet('tunebook:' + mid, allTunes);
    return allTunes;
  }

  async function loadTunebook(mid, forceReload) {
    if (!forceReload) {
      const cached = await dbGet('tunebook:' + mid);
      if (cached) return cached;
    }
    return fetchTunebookFromAPI(mid);
  }

  async function fetchTuneDetail(tuneId) {
    const cached = await dbGet('abc:' + tuneId);
    if (cached) return cached;

    const url = 'https://thesession.org/tunes/' + tuneId + '?format=json';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('API error fetching tune ' + tuneId + ': ' + resp.status);
    const data = await resp.json();

    if (!data.settings || data.settings.length === 0) {
      throw new Error('No settings found for tune ' + tuneId);
    }

    const detail = { key: data.settings[0].key, abc: data.settings[0].abc };
    await dbSet('abc:' + tuneId, detail);
    return detail;
  }

  // --- ABC helpers ---
  function convertKey(apiKey) {
    // "Gmajor" → "G", "Aminor" → "Am", "Amixolydian" → "AMix", etc.
    const modes = {
      'major': '', 'minor': 'm', 'mixolydian': 'Mix',
      'dorian': 'Dor', 'phrygian': 'Phr', 'lydian': 'Lyd', 'locrian': 'Loc'
    };
    var lower = apiKey.toLowerCase();
    for (var mode in modes) {
      if (lower.endsWith(mode)) {
        return apiKey.substring(0, apiKey.length - mode.length) + modes[mode];
      }
    }
    return apiKey;
  }

  function formatKeyDisplay(apiKey) {
    var lower = apiKey.toLowerCase();
    var modeList = ['major', 'minor', 'mixolydian', 'dorian', 'phrygian', 'lydian', 'locrian'];
    for (var i = 0; i < modeList.length; i++) {
      if (lower.endsWith(modeList[i])) {
        var note = apiKey.substring(0, apiKey.length - modeList[i].length);
        return note + ' ' + modeList[i];
      }
    }
    return apiKey;
  }

  function getTimeSig(type) {
    var sigs = {
      'reel': '4/4', 'jig': '6/8', 'slip jig': '9/8',
      'slide': '12/8', 'hornpipe': '4/4', 'polka': '2/4',
      'waltz': '3/4', 'barndance': '4/4', 'strathspey': '4/4',
      'mazurka': '3/4', 'three-two': '3/2'
    };
    return sigs[type] || '4/4';
  }

  function buildABCString(name, type, key, abcBody) {
    // thesession.org uses "!" after barlines as a line-break marker
    var cleaned = abcBody.replace(/([\|:])\s*!\s+/g, '$1\n');
    return 'X:1\nT:' + name + '\nM:' + getTimeSig(type) +
      '\nL:1/8\nK:' + convertKey(key) + '\n' + cleaned;
  }

  // --- Rhythm bucketing ---
  function bucketByRhythm() {
    var buckets = {};
    var today = todayStr();
    var played = getPlayedMap();

    for (var i = 0; i < tunebook.length; i++) {
      var tune = tunebook[i];
      if (!tune.type) continue;
      if (played[tune.id] === today) continue;
      if (!buckets[tune.type]) buckets[tune.type] = [];
      buckets[tune.type].push(tune);
    }
    return buckets;
  }

  // --- Set picking (ported from prototype) ---
  function pickSet(selectedRhythm) {
    var buckets = bucketByRhythm();

    // Weighted-random: each rhythm's weight = its bucket size
    var weightedRhythms = [];
    for (var r in buckets) {
      if (buckets[r].length >= 3) {
        for (var w = 0; w < buckets[r].length; w++) {
          weightedRhythms.push(r);
        }
      }
    }

    if (weightedRhythms.length === 0) {
      throw new Error('No rhythm has at least 3 playable tunes left today.');
    }

    var chosenRhythm;
    if (!selectedRhythm || selectedRhythm === 'random') {
      chosenRhythm = weightedRhythms[Math.floor(Math.random() * weightedRhythms.length)];
    } else {
      chosenRhythm = selectedRhythm;
      if (!buckets[chosenRhythm] || buckets[chosenRhythm].length < 3) {
        throw new Error('Not enough playable tunes for "' + chosenRhythm + '" today.');
      }
    }

    var selected = pickRandomUnique(buckets[chosenRhythm], 3);
    return { rhythm: chosenRhythm, tunes: selected };
  }

  // --- UI: populate rhythm dropdown ---
  function updateRhythmDropdown() {
    var buckets = bucketByRhythm();
    rhythmSelect.innerHTML = '<option value="random">Random</option>';

    var types = Object.keys(buckets).sort();
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var count = buckets[type].length;
      var opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type.charAt(0).toUpperCase() + type.slice(1) + ' (' + count + ')';
      if (count < 3) opt.disabled = true;
      rhythmSelect.appendChild(opt);
    }
  }

  // --- UI: render set ---
  async function renderSet(set) {
    setDisplay.innerHTML = '<h3>' + set.rhythm + ' set</h3>';

    var list = document.createElement('div');
    list.id = 'tuneList';
    setDisplay.appendChild(list);

    // Build cards first (before async ABC fetch)
    for (var i = 0; i < set.tunes.length; i++) {
      var tune = set.tunes[i];
      var card = document.createElement('div');
      card.className = 'tune-card';
      card.dataset.idx = i;

      var header = document.createElement('div');
      header.className = 'tune-header';
      header.innerHTML =
        '<span class="drag-handle">&#9776;</span>' +
        '<span class="tune-info">' +
          '<a href="' + tune.url + '" target="_blank">' + tune.name + '</a>' +
          '<span class="tune-key" id="key-' + i + '"></span>' +
        '</span>' +
        '<button class="mark-played-btn" data-tune-id="' + tune.id + '" data-idx="' + i + '">' +
          '&#10004; Played</button>';
      card.appendChild(header);

      var abcDiv = document.createElement('div');
      abcDiv.className = 'abc-render';
      abcDiv.id = 'abc-' + i;
      abcDiv.textContent = 'Loading notation...';
      card.appendChild(abcDiv);

      list.appendChild(card);
    }

    // SortableJS for drag reorder
    new Sortable(list, {
      animation: 150,
      handle: '.drag-handle',
      filter: 'button, a',
      preventOnFilter: false,
      ghostClass: 'sortable-ghost',
      onEnd: function (evt) {
        var moved = currentSet.tunes.splice(evt.oldIndex, 1)[0];
        currentSet.tunes.splice(evt.newIndex, 0, moved);
      }
    });

    // Fetch ABC for each tune in parallel
    var promises = set.tunes.map(function (tune, idx) {
      return fetchTuneDetail(tune.id).then(function (detail) {
        var abcStr = buildABCString(tune.name, tune.type, detail.key, detail.abc);
        ABCJS.renderAbc('abc-' + idx, abcStr, { responsive: 'resize' });
        document.getElementById('key-' + idx).textContent =
          ' \u2014 ' + formatKeyDisplay(detail.key);
        set.tunes[idx].key = detail.key;
        set.tunes[idx].abc = detail.abc;
      }).catch(function (e) {
        document.getElementById('abc-' + idx).textContent =
          'Failed to load notation: ' + e.message;
      });
    });

    await Promise.all(promises);
  }

  // --- Event: Load tunebook ---
  async function handleLoad(forceReload) {
    var mid = memberInput.value.trim();
    if (!mid) { alert('Please enter a member number.'); return; }

    loadBtn.disabled = true;
    reloadBtn.style.display = 'none';
    loadProgress.textContent = 'Loading...';
    tunebookInfo.textContent = '';
    pickerSection.style.display = 'none';
    setDisplay.innerHTML = '';
    currentSet = null;

    try {
      tunebook = await loadTunebook(mid, forceReload);
      memberId = mid;
      localStorage.setItem('lastMemberId', mid);
      loadProgress.textContent = '';
      tunebookInfo.textContent = 'Loaded ' + tunebook.length + ' tunes.';
      reloadBtn.style.display = '';
      updateRhythmDropdown();
      pickerSection.style.display = '';
    } catch (e) {
      loadProgress.textContent = '';
      alert('Error loading tunebook: ' + e.message);
    } finally {
      loadBtn.disabled = false;
    }
  }

  loadBtn.addEventListener('click', function () { handleLoad(false); });
  reloadBtn.addEventListener('click', function () { handleLoad(true); });

  // --- Event: Pick set ---
  pickBtn.addEventListener('click', async function () {
    try {
      currentSet = pickSet(rhythmSelect.value);
      saveBtn.disabled = false;
      await renderSet(currentSet);
    } catch (e) {
      alert(e.message);
    }
  });

  // --- Event: Save set ---
  saveBtn.addEventListener('click', function () {
    if (!currentSet) return;

    currentSet.tunes.forEach(function (t) { markTunePlayed(t.id); });

    // Record the saved set in localStorage
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    savedSets.push({
      date: todayStr(),
      rhythm: currentSet.rhythm,
      tunes: currentSet.tunes.map(function (t) { return { id: t.id, name: t.name }; })
    });
    localStorage.setItem('sets:' + memberId, JSON.stringify(savedSets));

    saveBtn.disabled = true;
    document.querySelectorAll('.mark-played-btn').forEach(function (b) { b.disabled = true; });
    updateRhythmDropdown();
  });

  // --- Event delegation: mark played ---
  setDisplay.addEventListener('click', function (e) {
    var btn = e.target.closest('.mark-played-btn');
    if (!btn || btn.disabled) return;
    var tuneId = Number(btn.dataset.tuneId);
    markTunePlayed(tuneId);
    btn.disabled = true;
    btn.textContent = '\u2714 Done';
    updateRhythmDropdown();
  });

  // --- Init: restore last member ID ---
  var lastMid = localStorage.getItem('lastMemberId');
  if (lastMid) memberInput.value = lastMid;

})();
