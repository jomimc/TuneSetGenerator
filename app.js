(function () {
  'use strict';

  // --- State ---
  // members[0] is the primary user; later entries are friends.
  // Each: { id: number|null, name: string|null, tunebook: array|null, loaded: bool }
  var members = [];
  var memberId = null;       // composite key of loaded member IDs (sorted, "+"-joined)
  var tunebook = [];         // intersection of all loaded tunebooks
  var currentSet = null;
  var incipitsData = null;   // combined incipits.json, keyed by tune_id string
  var tuneChunks = {};       // cached full-tune chunks, keyed by chunk number
  var showFullTunes = false;
  var setSize = 3;           // number of tunes per set (2–5)
  var keyMode = 'any';       // 'any' | 'same' | 'different'

  var CHUNK_SIZE = 1000;

  // --- IndexedDB via idb-keyval (tunebook cache only) ---
  var store = idbKeyval.createStore('tunesetgen', 'cache');

  function dbGet(key) { return idbKeyval.get(key, store); }
  function dbSet(key, val) { return idbKeyval.set(key, val, store); }

  // --- DOM refs ---
  var membersList = document.getElementById('members-list');
  var addMemberBtn = document.getElementById('addMemberBtn');
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
  var sizeButtons = document.getElementById('sizeButtons');
  var keyButtons = document.getElementById('keyButtons');
  var savedSetsModal = document.getElementById('saved-sets-modal');
  var savedSetsList = document.getElementById('saved-sets-list');
  var closeSavedModal = document.getElementById('closeSavedModal');

  var PLAYED_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
  var MAX_RECENT_USERS = 8;

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

  // --- Recent users ---
  function getRecentUsers() {
    try { return JSON.parse(localStorage.getItem('recentUsers') || '[]'); }
    catch (e) { return []; }
  }

  function addRecentUser(member) {
    if (!member || !member.id || !member.name) return;
    var users = getRecentUsers().filter(function (u) { return u.id !== member.id; });
    users.unshift({ id: member.id, name: member.name, lastUsed: Date.now() });
    users = users.slice(0, MAX_RECENT_USERS);
    localStorage.setItem('recentUsers', JSON.stringify(users));
  }

  function removeRecentUser(id) {
    var users = getRecentUsers().filter(function (u) { return u.id !== id; });
    localStorage.setItem('recentUsers', JSON.stringify(users));
  }

  function renderRecentUsersForRow(rowIndex) {
    var row = getRow(rowIndex);
    if (!row) return;
    var container = row.querySelector('.recent-users');
    var users = getRecentUsers();
    container.innerHTML = '';
    if (users.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';

    var label = document.createElement('span');
    label.className = 'recent-users-label';
    label.textContent = 'Recent:';
    container.appendChild(label);

    users.forEach(function (u) {
      var chip = document.createElement('button');
      chip.className = 'user-chip';
      chip.type = 'button';
      chip.dataset.id = u.id;

      var ownerIndex = members.findIndex(function (m) { return m.loaded && m.id === u.id; });
      if (ownerIndex === rowIndex) {
        chip.classList.add('active');
        chip.disabled = true;
        chip.title = u.name + ' (loaded here)';
      } else if (ownerIndex >= 0) {
        chip.classList.add('used');
        chip.disabled = true;
        chip.title = u.name + ' is already loaded in another row';
      } else {
        chip.title = 'Load tunebook for ' + u.name + ' (#' + u.id + ')';
      }

      var nameSpan = document.createElement('span');
      nameSpan.className = 'chip-name';
      nameSpan.textContent = u.name;
      chip.appendChild(nameSpan);

      var removeBtn = document.createElement('span');
      removeBtn.className = 'chip-remove';
      removeBtn.dataset.remove = u.id;
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove from recent';
      chip.appendChild(removeBtn);

      container.appendChild(chip);
    });
  }

  function renderAllRecentUsers() {
    for (var i = 0; i < members.length; i++) renderRecentUsersForRow(i);
  }

  // --- Member rows ---
  function getRow(rowIndex) {
    return membersList.querySelector('.member-row[data-row-index="' + rowIndex + '"]');
  }

  function createMemberRow(rowIndex) {
    var row = document.createElement('div');
    row.className = 'member-row';
    row.dataset.rowIndex = String(rowIndex);

    var label = document.createElement('label');
    label.textContent = 'thesession.org member #:';
    row.appendChild(label);

    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'member-input';
    input.min = '1';
    input.placeholder = 'e.g. 1';
    row.appendChild(input);

    var loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'load-btn';
    loadBtn.textContent = 'Load Tunebook';
    row.appendChild(loadBtn);

    var reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'reload-btn';
    reloadBtn.textContent = 'Reload';
    reloadBtn.style.display = 'none';
    row.appendChild(reloadBtn);

    var link = document.createElement('a');
    link.className = 'find-number-link';
    link.href = 'https://thesession.org/members';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = "Don't know your number?";
    row.appendChild(link);

    if (rowIndex > 0) {
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-row-btn';
      removeBtn.title = 'Remove this member';
      removeBtn.textContent = '\u00d7';
      row.appendChild(removeBtn);
    }

    var recent = document.createElement('div');
    recent.className = 'recent-users';
    row.appendChild(recent);

    return row;
  }

  function addMemberRow() {
    var rowIndex = members.length;
    members.push({ id: null, name: null, tunebook: null, loaded: false });
    membersList.appendChild(createMemberRow(rowIndex));
    renderRecentUsersForRow(rowIndex);
  }

  function removeMemberRow(rowIndex) {
    if (rowIndex === 0) return;
    members.splice(rowIndex, 1);
    getRow(rowIndex).remove();
    var rows = membersList.querySelectorAll('.member-row');
    rows.forEach(function (r, i) { r.dataset.rowIndex = String(i); });
    updateMemberIdentity();
    renderAllRecentUsers();
    updateTunebookInfo();
    if (getLoadedMembers().length > 0) {
      cleanPlayedMap();
      updateRhythmDropdown();
      updateSavedSetsButtons();
    } else {
      pickerSection.style.display = 'none';
      setDisplay.innerHTML = '';
      currentSet = null;
    }
  }

  // --- Member identity / intersection ---
  function getLoadedMembers() {
    return members.filter(function (m) { return m.loaded; });
  }

  function getIntersectionTunebook() {
    var loaded = getLoadedMembers();
    if (loaded.length === 0) return [];
    if (loaded.length === 1) return loaded[0].tunebook.slice();
    var base = loaded[0].tunebook;
    var otherIdSets = loaded.slice(1).map(function (m) {
      return new Set(m.tunebook.map(function (t) { return t.id; }));
    });
    return base.filter(function (t) {
      return otherIdSets.every(function (s) { return s.has(t.id); });
    });
  }

  function updateMemberIdentity() {
    var loaded = getLoadedMembers();
    if (loaded.length === 0) {
      memberId = null;
      tunebook = [];
      return;
    }
    var ids = loaded.map(function (m) { return m.id; }).sort(function (a, b) { return a - b; });
    memberId = ids.join('+');
    tunebook = getIntersectionTunebook();
  }

  function updateTunebookInfo() {
    var loaded = getLoadedMembers();
    if (loaded.length === 0) { tunebookInfo.textContent = ''; return; }
    if (loaded.length === 1) {
      tunebookInfo.textContent = 'Loaded ' + loaded[0].tunebook.length +
        ' tunes for ' + loaded[0].name + '.';
      return;
    }
    var parts = loaded.map(function (m) {
      return m.tunebook.length + ' for ' + m.name;
    }).join(', ');
    var common = tunebook.length;
    tunebookInfo.textContent = 'Loaded ' + parts + '. ' +
      common + ' tune' + (common === 1 ? '' : 's') + ' in common.';
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

    var memberInfo = data.member || null;
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
    if (memberInfo) await dbSet('memberInfo:' + mid, memberInfo);
    return { tunes: allTunes, member: memberInfo, fromCache: false };
  }

  async function loadTunebook(mid, forceReload) {
    if (!forceReload) {
      var cached = await dbGet('tunebook:' + mid);
      if (cached) {
        var cachedMember = await dbGet('memberInfo:' + mid);
        return { tunes: cached, member: cachedMember || null, fromCache: true };
      }
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
      var mode = null;
      if (incipitsData && incipitsData[String(tune.id)]) {
        mode = incipitsData[String(tune.id)].mode;
      }
      var enriched = {
        id: tune.id, name: tune.name, type: tune.type,
        url: tune.url, mode: mode
      };
      if (!buckets[tune.type]) buckets[tune.type] = [];
      buckets[tune.type].push(enriched);
    }
    return buckets;
  }

  function groupByKey(bucket) {
    var byKey = {};
    for (var i = 0; i < bucket.length; i++) {
      var t = bucket[i];
      if (!t.mode) continue;
      if (!byKey[t.mode]) byKey[t.mode] = [];
      byKey[t.mode].push(t);
    }
    return byKey;
  }

  function rhythmEligible(bucket, size, kmode) {
    if (bucket.length < size) return false;
    if (kmode === 'any') return true;
    if (kmode === 'same') {
      var byKey = groupByKey(bucket);
      for (var k in byKey) if (byKey[k].length >= size) return true;
      return false;
    }
    if (kmode === 'different') {
      var seen = {};
      for (var i = 0; i < bucket.length; i++) {
        if (bucket[i].mode) seen[bucket[i].mode] = true;
      }
      return Object.keys(seen).length >= size;
    }
    return false;
  }

  function pickFromBucket(bucket, size, kmode) {
    if (kmode === 'same') {
      var byKey = groupByKey(bucket);
      var eligible = Object.keys(byKey).filter(function (k) {
        return byKey[k].length >= size;
      });
      if (eligible.length === 0) return null;
      var chosenKey = eligible[Math.floor(Math.random() * eligible.length)];
      return pickRandomUnique(byKey[chosenKey], size);
    }
    if (kmode === 'different') {
      var byKey2 = groupByKey(bucket);
      var keys = Object.keys(byKey2);
      for (var i = keys.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = keys[i]; keys[i] = keys[j]; keys[j] = tmp;
      }
      if (keys.length < size) return null;
      var picked = [];
      for (var k = 0; k < size; k++) {
        var pool = byKey2[keys[k]];
        picked.push(pool[Math.floor(Math.random() * pool.length)]);
      }
      return picked;
    }
    return pickRandomUnique(bucket, size);
  }

  // --- Set picking ---
  function pickSet(selectedRhythm) {
    var buckets = bucketByRhythm();

    var weightedRhythms = [];
    for (var r in buckets) {
      if (rhythmEligible(buckets[r], setSize, keyMode)) {
        for (var w = 0; w < buckets[r].length; w++) weightedRhythms.push(r);
      }
    }

    if (weightedRhythms.length === 0) {
      throw new Error('No rhythm has enough playable tunes for the current size/key settings.');
    }

    var chosenRhythm;
    if (!selectedRhythm || selectedRhythm === 'random') {
      chosenRhythm = weightedRhythms[Math.floor(Math.random() * weightedRhythms.length)];
    } else {
      chosenRhythm = selectedRhythm;
      if (!buckets[chosenRhythm] || !rhythmEligible(buckets[chosenRhythm], setSize, keyMode)) {
        throw new Error('Not enough playable tunes for "' + chosenRhythm + '" with current settings.');
      }
    }

    var selected = pickFromBucket(buckets[chosenRhythm], setSize, keyMode);
    if (!selected) throw new Error('Could not pick a set with current settings.');
    return { rhythm: chosenRhythm, tunes: selected };
  }

  // --- Reroll a single tune within the current set ---
  function rerollTune(idx) {
    if (!currentSet) return;
    var buckets = bucketByRhythm();
    var bucket = (buckets[currentSet.rhythm] || []).slice();

    var currentIds = {};
    currentSet.tunes.forEach(function (t) { currentIds[t.id] = true; });
    bucket = bucket.filter(function (t) { return !currentIds[t.id]; });

    if (keyMode === 'same') {
      var targetMode = null;
      for (var i = 0; i < currentSet.tunes.length; i++) {
        if (i !== idx && currentSet.tunes[i].mode) {
          targetMode = currentSet.tunes[i].mode;
          break;
        }
      }
      if (targetMode) {
        bucket = bucket.filter(function (t) { return t.mode === targetMode; });
      }
    } else if (keyMode === 'different') {
      var used = {};
      currentSet.tunes.forEach(function (t, i) {
        if (i !== idx && t.mode) used[t.mode] = true;
      });
      bucket = bucket.filter(function (t) { return t.mode && !used[t.mode]; });
    }

    if (bucket.length === 0) {
      alert('No replacement tune available with current settings.');
      return;
    }

    var newTune = bucket[Math.floor(Math.random() * bucket.length)];
    currentSet.tunes[idx] = newTune;
    renderSet(currentSet);
  }

  // --- UI: populate rhythm dropdown ---
  function updateRhythmDropdown() {
    var buckets = bucketByRhythm();
    var prev = rhythmSelect.value;
    rhythmSelect.innerHTML = '<option value="random">Random</option>';

    var types = Object.keys(buckets).sort();
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var count = buckets[type].length;
      var opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type.charAt(0).toUpperCase() + type.slice(1) + ' (' + count + ')';
      if (count < setSize) opt.disabled = true;
      rhythmSelect.appendChild(opt);
    }

    // Preserve user's previous choice if still available and pickable
    var stillPickable = Array.prototype.some.call(rhythmSelect.options, function (o) {
      return o.value === prev && !o.disabled;
    });
    if (prev && stillPickable) rhythmSelect.value = prev;
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
        '<button class="reroll-btn" data-idx="' + i + '" title="Replace with a new random tune">' +
          '&#8634; Reroll</button>' +
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

  // --- Event: Load tunebook (per row) ---
  async function handleRowLoad(rowIndex, forceReload) {
    var row = getRow(rowIndex);
    if (!row) return;
    var input = row.querySelector('.member-input');
    var rowLoadBtn = row.querySelector('.load-btn');
    var rowReloadBtn = row.querySelector('.reload-btn');

    var midStr = input.value.trim();
    if (!midStr) { alert('Please enter a member number.'); return; }
    var midNum = Number(midStr);

    // Guard against duplicate members across rows
    var duplicateIdx = members.findIndex(function (m, i) {
      return i !== rowIndex && m.loaded && m.id === midNum;
    });
    if (duplicateIdx >= 0) {
      alert('Member #' + midNum + ' is already loaded in another row.');
      return;
    }

    rowLoadBtn.disabled = true;
    rowReloadBtn.style.display = 'none';
    loadProgress.textContent = 'Loading...';

    // If no member was loaded yet, clear any stale picker UI.
    if (!getLoadedMembers().length) {
      pickerSection.style.display = 'none';
      setDisplay.innerHTML = '';
      currentSet = null;
    }

    try {
      await loadIncipitsData();
      var result = await loadTunebook(midStr, forceReload);
      var resolvedId = result.member ? result.member.id : midNum;
      var resolvedName = (result.member && result.member.name) || ('Member #' + resolvedId);

      members[rowIndex] = {
        id: resolvedId,
        name: resolvedName,
        tunebook: result.tunes,
        loaded: true
      };
      if (result.member) addRecentUser(result.member);
      if (rowIndex === 0) localStorage.setItem('lastMemberId', midStr);

      updateMemberIdentity();
      cleanPlayedMap();
      loadProgress.textContent = '';
      updateTunebookInfo();
      rowReloadBtn.style.display = result.fromCache ? '' : 'none';
      renderAllRecentUsers();
      updateRhythmDropdown();
      updateSavedSetsButtons();
      pickerSection.style.display = '';
    } catch (e) {
      loadProgress.textContent = '';
      alert('Error loading tunebook: ' + e.message);
    } finally {
      rowLoadBtn.disabled = false;
    }
  }

  // Event delegation for all member-row interactions
  membersList.addEventListener('click', function (e) {
    var row = e.target.closest('.member-row');
    if (!row) return;
    var rowIndex = Number(row.dataset.rowIndex);

    // chip × (must check before chip, and before disabled-chip early return)
    var removeChipEl = e.target.closest('[data-remove]');
    if (removeChipEl && e.target.closest('.recent-users')) {
      e.stopPropagation();
      removeRecentUser(Number(removeChipEl.dataset.remove));
      renderAllRecentUsers();
      return;
    }

    if (e.target.closest('.load-btn')) {
      handleRowLoad(rowIndex, false);
      return;
    }
    if (e.target.closest('.reload-btn')) {
      handleRowLoad(rowIndex, true);
      return;
    }
    if (e.target.closest('.remove-row-btn')) {
      removeMemberRow(rowIndex);
      return;
    }

    var chip = e.target.closest('.user-chip');
    if (chip && !chip.disabled) {
      row.querySelector('.member-input').value = chip.dataset.id;
      handleRowLoad(rowIndex, false);
    }
  });

  addMemberBtn.addEventListener('click', function () { addMemberRow(); });

  // --- Event: Size buttons ---
  sizeButtons.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-size]');
    if (!btn) return;
    setSize = Number(btn.dataset.size);
    sizeButtons.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    if (getLoadedMembers().length > 0) updateRhythmDropdown();
  });

  // --- Event: Key mode buttons ---
  keyButtons.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-key]');
    if (!btn) return;
    keyMode = btn.dataset.key;
    keyButtons.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
  });

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
    document.querySelectorAll('.mark-played-btn, .reroll-btn').forEach(function (b) { b.disabled = true; });
    updateRhythmDropdown();
    updateSavedSetsButtons();
  });

  // --- Event: Played Set (Don't Save) ---
  playedSetBtn.addEventListener('click', function () {
    if (!currentSet) return;

    currentSet.tunes.forEach(function (t) { markTunePlayed(t.id); });

    saveBtn.disabled = true;
    playedSetBtn.disabled = true;
    document.querySelectorAll('.mark-played-btn, .reroll-btn').forEach(function (b) { b.disabled = true; });
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

  // --- Event delegation: mark played / reroll ---
  setDisplay.addEventListener('click', function (e) {
    var playedBtn = e.target.closest('.mark-played-btn');
    if (playedBtn && !playedBtn.disabled) {
      var tuneId = Number(playedBtn.dataset.tuneId);
      markTunePlayed(tuneId);
      playedBtn.disabled = true;
      playedBtn.textContent = '\u2714 Done';
      var card = playedBtn.closest('.tune-card');
      var reroll = card && card.querySelector('.reroll-btn');
      if (reroll) reroll.disabled = true;
      updateRhythmDropdown();
      return;
    }

    var rerollBtn = e.target.closest('.reroll-btn');
    if (rerollBtn && !rerollBtn.disabled) {
      var idx = Number(rerollBtn.dataset.idx);
      rerollTune(idx);
    }
  });

  // --- Event: Full tune toggle ---
  fullTuneToggle.addEventListener('change', function () {
    showFullTunes = fullTuneToggle.checked;
    if (currentSet) {
      renderSet(currentSet);
    }
  });

  // --- Init ---
  members.push({ id: null, name: null, tunebook: null, loaded: false });
  membersList.appendChild(createMemberRow(0));

  var lastMid = localStorage.getItem('lastMemberId');
  if (lastMid) getRow(0).querySelector('.member-input').value = lastMid;

  renderRecentUsersForRow(0);

  // Pre-load incipits data in background
  loadIncipitsData().catch(function (e) {
    console.warn('Failed to pre-load incipits:', e.message);
  });

})();
