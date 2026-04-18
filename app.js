(function () {
  'use strict';

  // --- State ---
  var memberId = null;
  var tunebook = [];
  var currentSet = null;
  var incipitsData = null;   // combined incipits.json, keyed by tune_id string
  var tuneChunks = {};       // cached full-tune chunks, keyed by chunk number
  var showFullTunes = false;

  var CHUNK_SIZE = 1000;

  // --- IndexedDB via idb-keyval (tunebook cache only) ---
  var store = idbKeyval.createStore('tunesetgen', 'cache');

  function dbGet(key) { return idbKeyval.get(key, store); }
  function dbSet(key, val) { return idbKeyval.set(key, val, store); }

  // --- DOM refs ---
  var memberInput = document.getElementById('memberInput');
  var loadBtn = document.getElementById('loadBtn');
  var reloadBtn = document.getElementById('reloadBtn');
  var loadProgress = document.getElementById('loadProgress');
  var tunebookInfo = document.getElementById('tunebookInfo');
  var pickerSection = document.getElementById('picker-section');
  var rhythmSelect = document.getElementById('rhythmSelect');
  var pickBtn = document.getElementById('pickBtn');
  var saveBtn = document.getElementById('saveBtn');
  var playedSetBtn = document.getElementById('playedSetBtn');
  var chooseSavedBtn = document.getElementById('chooseSavedBtn');
  var downloadSavedBtn = document.getElementById('downloadSavedBtn');
  var setDisplay = document.getElementById('set-display');
  var fullTuneToggle = document.getElementById('fullTuneToggle');
  var savedSetsModal = document.getElementById('saved-sets-modal');
  var savedSetsList = document.getElementById('saved-sets-list');
  var closeSavedModal = document.getElementById('closeSavedModal');

  var PLAYED_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

  // --- Utility ---
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function pickRandomUnique(array, count) {
    var shuffled = array.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    return shuffled.slice(0, count);
  }

  // --- Played tracking (localStorage, 24-hour timer) ---
  function getPlayedMap() {
    var raw = localStorage.getItem('played:' + memberId);
    return raw ? JSON.parse(raw) : {};
  }

  function setPlayedMap(map) {
    localStorage.setItem('played:' + memberId, JSON.stringify(map));
  }

  function markTunePlayed(tuneId) {
    var map = getPlayedMap();
    map[tuneId] = Date.now();
    setPlayedMap(map);
  }

  function isPlayedRecently(tuneId, playedMap) {
    var ts = playedMap[tuneId];
    if (!ts) return false;
    var cutoff = Date.now() - PLAYED_DURATION_MS;
    // Support legacy date string format ("YYYY-MM-DD")
    if (typeof ts === 'string') {
      return new Date(ts + 'T23:59:59').getTime() > cutoff;
    }
    return ts > cutoff;
  }

  function cleanPlayedMap() {
    var map = getPlayedMap();
    var cutoff = Date.now() - PLAYED_DURATION_MS;
    var changed = false;
    for (var id in map) {
      var ts = map[id];
      var expired = (typeof ts === 'number') ? ts < cutoff
        : new Date(ts + 'T23:59:59').getTime() < cutoff;
      if (expired) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) setPlayedMap(map);
  }

  // --- Tune data loading ---

  // Load combined incipits.json into memory (called once on app start)
  async function loadIncipitsData() {
    if (incipitsData) return;
    var resp = await fetch('data/incipits.json');
    if (!resp.ok) throw new Error('Failed to load incipits data');
    incipitsData = await resp.json();
  }

  // Load a full-tune chunk on demand, cache in memory
  async function loadTuneChunk(chunkId) {
    if (tuneChunks[chunkId]) return tuneChunks[chunkId];
    var resp = await fetch('data/tunes/' + chunkId + '.json');
    if (!resp.ok) throw new Error('Failed to load tune chunk ' + chunkId);
    tuneChunks[chunkId] = await resp.json();
    return tuneChunks[chunkId];
  }

  // Get tune data for a given tune ID (incipit or full depending on toggle)
  async function getTuneData(tuneId) {
    var tid = String(tuneId);
    if (!showFullTunes) {
      if (incipitsData && incipitsData[tid]) return incipitsData[tid];
    } else {
      var chunkId = Math.floor(parseInt(tid) / CHUNK_SIZE);
      var chunk = await loadTuneChunk(chunkId);
      if (chunk[tid]) return chunk[tid];
    }
    // Fallback: fetch from thesession.org API
    return fetchTuneDetailAPI(tuneId);
  }

  // --- Tunebook API ---
  async function fetchTunebookFromAPI(mid) {
    loadProgress.textContent = 'Fetching tunebook...';
    var url = 'https://thesession.org/members/' + mid +
      '/tunebook?format=json&perpage=100&page=1';
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('API error: ' + resp.status);
    var data = await resp.json();

    if (!data.tunes || data.tunes.length === 0) {
      throw new Error('No tunes found. Check the member number.');
    }

    var totalPages = data.pages;
    var allTunes = data.tunes.slice();

    if (totalPages > 1) {
      loadProgress.textContent = 'Fetching pages 2\u2013' + totalPages + ' in parallel...';
      var promises = [];
      for (var p = 2; p <= totalPages; p++) {
        var pageUrl = 'https://thesession.org/members/' + mid +
          '/tunebook?format=json&perpage=100&page=' + p;
        promises.push(
          fetch(pageUrl).then(function (r) {
            if (!r.ok) throw new Error('API error: ' + r.status);
            return r.json();
          })
        );
      }
      var results = await Promise.all(promises);
      for (var i = 0; i < results.length; i++) {
        allTunes.push.apply(allTunes, results[i].tunes);
      }
    }

    await dbSet('tunebook:' + mid, allTunes);
    return allTunes;
  }

  async function loadTunebook(mid, forceReload) {
    if (!forceReload) {
      var cached = await dbGet('tunebook:' + mid);
      if (cached) return cached;
    }
    return fetchTunebookFromAPI(mid);
  }

  // Fallback for tunes not in preprocessed data
  async function fetchTuneDetailAPI(tuneId) {
    var url = 'https://thesession.org/tunes/' + tuneId + '?format=json';
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('API error fetching tune ' + tuneId);
    var data = await resp.json();
    if (!data.settings || data.settings.length === 0) {
      throw new Error('No settings for tune ' + tuneId);
    }
    var s = data.settings[0];
    return {
      name: data.name,
      type: data.type,
      meter: getTimeSig(data.type),
      mode: s.key,
      abc: s.abc
    };
  }

  // --- ABC helpers ---
  function convertKey(apiKey) {
    var modes = {
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

  // Used only by the API fallback
  function getTimeSig(type) {
    var sigs = {
      'reel': '4/4', 'jig': '6/8', 'slip jig': '9/8',
      'slide': '12/8', 'hornpipe': '4/4', 'polka': '2/4',
      'waltz': '3/4', 'barndance': '4/4', 'strathspey': '4/4',
      'mazurka': '3/4', 'three-two': '3/2'
    };
    return sigs[type] || '4/4';
  }

  function buildABCString(tuneData) {
    // tuneData: {name, type, meter, mode, abc}
    // Handle thesession.org "!" line-break markers (API fallback data)
    var cleaned = tuneData.abc.replace(/([\|:])\s*!\s+/g, '$1\n');
    return 'X:1\nT:' + tuneData.name +
      '\nM:' + tuneData.meter +
      '\nL:1/8\nK:' + convertKey(tuneData.mode) +
      '\n' + cleaned;
  }

  // --- Rhythm bucketing ---
  function bucketByRhythm() {
    var buckets = {};
    var played = getPlayedMap();

    for (var i = 0; i < tunebook.length; i++) {
      var tune = tunebook[i];
      if (!tune.type) continue;
      if (isPlayedRecently(tune.id, played)) continue;
      if (!buckets[tune.type]) buckets[tune.type] = [];
      buckets[tune.type].push(tune);
    }
    return buckets;
  }

  // --- Set picking (ported from prototype) ---
  function pickSet(selectedRhythm) {
    var buckets = bucketByRhythm();

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

    // Look up tune data and render ABC
    var promises = set.tunes.map(function (tune, idx) {
      return getTuneData(tune.id).then(function (tuneData) {
        // Store mode on tune object for save/download
        tune.mode = tuneData.mode;
        var abcStr = buildABCString(tuneData);
        ABCJS.renderAbc('abc-' + idx, abcStr, { responsive: 'resize' });
        document.getElementById('key-' + idx).textContent =
          ' \u2014 ' + formatKeyDisplay(tuneData.mode);
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
      // Load incipits data and tunebook in parallel
      await Promise.all([
        loadIncipitsData(),
        loadTunebook(mid, forceReload).then(function (t) { tunebook = t; })
      ]);
      memberId = mid;
      localStorage.setItem('lastMemberId', mid);
      cleanPlayedMap();
      loadProgress.textContent = '';
      tunebookInfo.textContent = 'Loaded ' + tunebook.length + ' tunes.';
      reloadBtn.style.display = '';
      updateRhythmDropdown();
      updateSavedSetsButtons();
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
      playedSetBtn.disabled = false;
      await renderSet(currentSet);
    } catch (e) {
      alert(e.message);
    }
  });

  // --- Event: Save set ---
  saveBtn.addEventListener('click', function () {
    if (!currentSet) return;

    currentSet.tunes.forEach(function (t) { markTunePlayed(t.id); });

    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    savedSets.push({
      date: new Date().toISOString(),
      rhythm: currentSet.rhythm,
      tunes: currentSet.tunes.map(function (t) {
        return { id: t.id, name: t.name, type: t.type, mode: t.mode || '' };
      })
    });
    localStorage.setItem('sets:' + memberId, JSON.stringify(savedSets));

    saveBtn.disabled = true;
    playedSetBtn.disabled = true;
    document.querySelectorAll('.mark-played-btn').forEach(function (b) { b.disabled = true; });
    updateRhythmDropdown();
    updateSavedSetsButtons();
  });

  // --- Event: Played Set (Don't Save) ---
  playedSetBtn.addEventListener('click', function () {
    if (!currentSet) return;

    currentSet.tunes.forEach(function (t) { markTunePlayed(t.id); });

    saveBtn.disabled = true;
    playedSetBtn.disabled = true;
    document.querySelectorAll('.mark-played-btn').forEach(function (b) { b.disabled = true; });
    updateRhythmDropdown();
  });

  // --- Saved sets helpers ---
  function updateSavedSetsButtons() {
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    var hasSaved = savedSets.length > 0;
    chooseSavedBtn.disabled = !hasSaved;
    downloadSavedBtn.disabled = !hasSaved;
  }

  function formatSavedDate(dateStr) {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // --- Event: Choose from Saved Sets ---
  chooseSavedBtn.addEventListener('click', function () {
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    if (savedSets.length === 0) { alert('No saved sets.'); return; }

    savedSetsList.innerHTML = '';
    for (var i = 0; i < savedSets.length; i++) {
      var set = savedSets[i];
      var item = document.createElement('div');
      item.className = 'saved-set-item';
      item.dataset.index = i;

      var tuneNames = set.tunes.map(function (t) { return t.name; }).join(', ');
      item.innerHTML =
        '<strong>' + formatSavedDate(set.date) + '</strong> \u2014 ' +
        set.rhythm + ' set<br>' +
        '<span class="saved-set-tunes">' + tuneNames + '</span>';
      savedSetsList.appendChild(item);
    }
    savedSetsModal.style.display = 'flex';
  });

  savedSetsList.addEventListener('click', function (e) {
    var item = e.target.closest('.saved-set-item');
    if (!item) return;

    var idx = parseInt(item.dataset.index);
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    var set = savedSets[idx];

    currentSet = {
      rhythm: set.rhythm,
      tunes: set.tunes.map(function (t) {
        return {
          id: t.id,
          name: t.name,
          type: t.type || set.rhythm,
          url: 'https://thesession.org/tunes/' + t.id,
          mode: t.mode || ''
        };
      })
    };

    savedSetsModal.style.display = 'none';
    saveBtn.disabled = true;
    playedSetBtn.disabled = false;
    renderSet(currentSet);
  });

  closeSavedModal.addEventListener('click', function () {
    savedSetsModal.style.display = 'none';
  });

  savedSetsModal.addEventListener('click', function (e) {
    if (e.target === savedSetsModal) savedSetsModal.style.display = 'none';
  });

  // --- Event: Download Saved Sets ---
  downloadSavedBtn.addEventListener('click', function () {
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    if (savedSets.length === 0) { alert('No saved sets to download.'); return; }

    var rows = [];
    for (var i = 0; i < savedSets.length; i++) {
      var set = savedSets[i];
      for (var j = 0; j < set.tunes.length; j++) {
        var tune = set.tunes[j];
        rows.push({
          'Set #': i + 1,
          'Date': formatSavedDate(set.date),
          'Dance Type': set.rhythm,
          'Tune #': j + 1,
          'Tune ID': tune.id,
          'Tune Name': tune.name,
          'Key/Mode': tune.mode ? formatKeyDisplay(tune.mode) : ''
        });
      }
    }

    var ws = XLSX.utils.json_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Saved Sets');
    XLSX.writeFile(wb, 'saved_sets.xlsx');
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

  // --- Event: Full tune toggle ---
  fullTuneToggle.addEventListener('change', function () {
    showFullTunes = fullTuneToggle.checked;
    if (currentSet) {
      renderSet(currentSet);
    }
  });

  // --- Init ---
  var lastMid = localStorage.getItem('lastMemberId');
  if (lastMid) memberInput.value = lastMid;

  // Pre-load incipits data in background
  loadIncipitsData().catch(function (e) {
    console.warn('Failed to pre-load incipits:', e.message);
  });

})();
