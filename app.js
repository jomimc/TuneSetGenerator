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
  var incipitChunks = {};    // cached per-setting incipit chunks (multi-setting tunes)
  var showFullTunes = false; // "All Full" default; per-tune .full overrides this
  var nameOnly = false;      // "Name only" — hides all notation, overrides full
  // Remembered per-tune setting choice: { tuneId(string): settingIdx }. Tune
  // settings are global (not member-specific), so this is a single shared map.
  var settingChoices = {};
  // Size memory: a numeric size (all sources) plus an "any/random" override that
  // only applies to sources offering it (pre-existing sets). Both persist across
  // source switches, like keyMode does.
  var sizeNumeric = 3;       // 2–5
  var sizeAny = false;       // "Random" size chosen (pre-existing-set sources)
  var keyMode = 'any';       // 'any' | 'same' | 'different'
  var setCommitted = false;  // true once the current set is saved / all-played

  // Set source: 'random' (tunebook), 'mysets', 'usersets', 'recordings', 'poptunes'
  var source = 'poptunes';   // new default for first-time users
  var onlyKnown = true;      // set modes: restrict to fully-known sets

  // Lazily loaded popularity datasets (see preprocess.py)
  var popularityData = null; // { tune_id: tunebook_count }
  var userSetsData = null;   // [ { t:[ids], n:count, r:rhythm } ]
  var recordedSetsData = null;

  // Cached popularity-sorted views, built on demand for rank-based "Top X%".
  var sortedTuneIds = null;          // tune ids (with a rhythm) by adds, desc
  var sortedSetsCache = {};          // source -> sets sorted by count, desc

  // Popularity options per source. "Top X%" is rank-based (the X% most popular
  // items); recordings use explicit occurrence-count ranges.
  var POP_OPTIONS = {
    poptunes: [
      { label: 'Top 50%', pct: 50 }, { label: 'Top 25%', pct: 25 },
      { label: 'Top 10%', pct: 10 }, { label: 'Top 5%', pct: 5 },
      { label: 'Top 1%', pct: 1 }
    ],
    usersets: [
      { label: 'Any', pct: 100 }, { label: 'Top 40%', pct: 40 },
      { label: 'Top 10%', pct: 10 }, { label: 'Top 5%', pct: 5 },
      { label: 'Top 1%', pct: 1 }
    ],
    recordings: [
      { label: 'Recorded once', min: 1, max: 1 },
      { label: 'Recorded 2–10 times', min: 2, max: 10 },
      { label: 'Recorded 10+ times', min: 11, max: Infinity }
    ]
  };
  var POP_DEFAULT = { poptunes: 4, usersets: 1, recordings: 1 }; // poptunes now defaults to Top 1% (index 4)
  // Each popularity source remembers its own selected option.
  var popIdxBySource = {
    poptunes: POP_DEFAULT.poptunes,
    usersets: POP_DEFAULT.usersets,
    recordings: POP_DEFAULT.recordings
  };

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
  var tunebookSection = document.getElementById('tunebook-section');
  var tunebookHeaderBtn = document.getElementById('tunebookHeaderBtn');
  var settingsSection = document.getElementById('settings-section');
  var settingsHeaderBtn = document.getElementById('settingsHeaderBtn');
  var generateSection = document.getElementById('generate-section');
  var rhythmSelect = document.getElementById('rhythmSelect');
  var pickBtn = document.getElementById('pickBtn');
  var saveBtn = document.getElementById('saveBtn');
  var chooseSavedBtn = document.getElementById('chooseSavedBtn');
  var downloadSavedBtn = document.getElementById('downloadSavedBtn');
  var pdfBtn = document.getElementById('pdfBtn');
  var setDisplay = document.getElementById('set-display');
  var sourceButtonsTier1 = document.getElementById('sourceButtonsTier1');
  var sourceButtonsTier2 = document.getElementById('sourceButtonsTier2');
  var sourceUnavailableMsg = document.getElementById('sourceUnavailableMsg');
  var sizeButtons = document.getElementById('sizeButtons');
  var randomSizeBtn = document.getElementById('randomSizeBtn');
  var keyButtons = document.getElementById('keyButtons');
  var popularityButtons = document.getElementById('popularityButtons');
  var popularityRow = document.getElementById('popularityRow');
  var knownRow = document.getElementById('knownRow');
  var onlyKnownToggle = document.getElementById('onlyKnownToggle');
  var savedSetsModal = document.getElementById('saved-sets-modal');
  var savedSetsList = document.getElementById('saved-sets-list');
  var closeSavedModal = document.getElementById('closeSavedModal');

  var locationModal = document.getElementById('location-modal');
  var memberNameInput = document.getElementById('memberNameInput');
  var memberNameSearchBtn = document.getElementById('memberNameSearchBtn');
  var locationPlaceInput = document.getElementById('locationPlaceInput');
  var locationSearchBtn = document.getElementById('locationSearchBtn');
  var locationGeoBtn = document.getElementById('locationGeoBtn');
  var locationNameFilter = document.getElementById('locationNameFilter');
  var locationStatus = document.getElementById('locationStatus');
  var locationResults = document.getElementById('location-results');
  var locationMore = document.getElementById('locationMore');
  var closeLocationModal = document.getElementById('closeLocationModal');

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

  // --- Picker preferences (cached in localStorage; stable across sessions) ---
  function savePrefs() {
    try {
      localStorage.setItem('pickerPrefs', JSON.stringify({
        source: source, sizeNumeric: sizeNumeric, sizeAny: sizeAny,
        keyMode: keyMode, onlyKnown: onlyKnown, showFull: showFullTunes,
        nameOnly: nameOnly, popIdx: popIdxBySource,
        tunebookCollapsed: tunebookSection.classList.contains('collapsed'),
        settingsCollapsed: settingsSection.classList.contains('collapsed')
      }));
    } catch (e) { /* ignore quota/availability errors */ }
  }
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('pickerPrefs') || '{}'); }
    catch (e) { return {}; }
  }

  // --- Remembered per-tune setting choices (separate, shared across members) ---
  function loadSettingChoices() {
    try { settingChoices = JSON.parse(localStorage.getItem('settingChoices') || '{}'); }
    catch (e) { settingChoices = {}; }
  }
  function saveSettingChoices() {
    try { localStorage.setItem('settingChoices', JSON.stringify(settingChoices)); }
    catch (e) { /* ignore quota/availability errors */ }
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

    if (rowIndex > 0) {
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-row-btn';
      removeBtn.title = 'Remove this member';
      removeBtn.textContent = '\u00d7';
      row.appendChild(removeBtn);
    }

    var help = document.createElement('span');
    help.className = 'find-number';
    help.innerHTML =
      "Don't know your number? " +
      '<button type="button" class="find-member-btn">Search by name or location</button>';
    row.appendChild(help);

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
    mySetsMemberId = null; // primary member may have changed
    updateControlVisibility();
    if (getLoadedMembers().length > 0) {
      cleanPlayedMap();
      if (source === 'mysets') applySource(); else updateRhythmDropdown();
      updateSavedSetsButtons();
    } else {
      setDisplay.innerHTML = '';
      currentSet = null;
      mySetsData = [];
      // "My…" sources need a tunebook; fall back if the last one was removed.
      if (source === 'random' || source === 'mysets') {
        source = 'poptunes';
        setSourceActive(source);
        savePrefs();
        applySource();
      } else {
        updateRhythmDropdown();
      }
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
    if (loaded.length === 0) { tunebookInfo.innerHTML = ''; return; }
    var html = '';
    if (loaded.length === 1) {
      html = '<div>Loaded ' + loaded[0].tunebook.length +
        ' tunes for ' + loaded[0].name + '.</div>';
      if (loaded[0].sets !== undefined) {
        html += '<div>Loaded ' + loaded[0].sets.length +
          ' set' + (loaded[0].sets.length === 1 ? '' : 's') + ' for ' + loaded[0].name + '.</div>';
      }
    } else {
      var parts = loaded.map(function (m) {
        return m.tunebook.length + ' tunes for ' + m.name;
      }).join(', ');
      var common = tunebook.length;
      html = '<div>Loaded ' + parts + '. ' +
        common + ' tune' + (common === 1 ? '' : 's') + ' in common.</div>';
      var allHaveSets = loaded.every(function (m) { return m.sets !== undefined; });
      if (allHaveSets) {
        var setsParts = loaded.map(function (m) {
          return m.sets.length + ' sets for ' + m.name;
        }).join(', ');
        html += '<div>Loaded ' + setsParts + '.</div>';
      }
    }
    tunebookInfo.innerHTML = html;
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

  // Load a popularity/set dataset once, cache in memory
  async function loadJSON(path) {
    var resp = await fetch(path);
    if (!resp.ok) throw new Error('Failed to load ' + path);
    return resp.json();
  }
  async function loadPopularity() {
    if (!popularityData) popularityData = await loadJSON('data/popularity.json');
    return popularityData;
  }
  async function loadUserSets() {
    if (!userSetsData) userSetsData = await loadJSON('data/user_sets.json');
    return userSetsData;
  }
  async function loadRecordedSets() {
    if (!recordedSetsData) recordedSetsData = await loadJSON('data/recorded_sets.json');
    return recordedSetsData;
  }

  // A member's own saved sets, fetched from thesession.org and cached in IndexedDB.
  var mySetsData = null;       // [ { t:[ids], r:rhythm, name } ] for the primary member
  var mySetsMemberId = null;

  async function fetchMemberSets(mid) {
    var base = 'https://thesession.org/members/' + mid + '/sets?format=json&perpage=50&page=';
    var first = await (await fetch(base + '1')).json();
    var raw = (first.sets || []).slice();
    if (first.pages > 1) {
      var proms = [];
      for (var p = 2; p <= first.pages; p++) {
        proms.push(fetch(base + p).then(function (r) { return r.json(); }));
      }
      (await Promise.all(proms)).forEach(function (r) {
        raw.push.apply(raw, r.sets || []);
      });
    }
    return raw;
  }

  function parseMemberSets(rawSets) {
    return (rawSets || []).map(function (s) {
      var ids = (s.settings || []).map(function (st) {
        var m = /tunes\/(\d+)/.exec(st.url || '');
        return m ? Number(m[1]) : null;
      }).filter(Boolean);
      var r = (s.settings && s.settings[0] && s.settings[0].type) || '';
      return { t: ids, r: r, name: s.name || '' };
    }).filter(function (s) { return s.t.length >= 2; });
  }

  async function ensureMySets() {
    var primary = getLoadedMembers()[0];
    if (!primary) { mySetsData = []; mySetsMemberId = null; return; }
    if (mySetsMemberId === primary.id && mySetsData) return;
    // Reuse already-loaded sets if available
    if (primary.sets) {
      mySetsData = primary.sets;
      mySetsMemberId = primary.id;
      return;
    }
    var cached = await dbGet('mysets:' + primary.id);
    if (!cached) {
      cached = await fetchMemberSets(primary.id);
      await dbSet('mysets:' + primary.id, cached);
    }
    mySetsData = parseMemberSets(cached);
    mySetsMemberId = primary.id;
  }
  // Random index proportional to weights (used to favour larger rhythm pools).
  function pickWeightedIndex(weights) {
    var total = 0;
    for (var i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return Math.floor(Math.random() * weights.length);
    var r = Math.random() * total;
    for (var j = 0; j < weights.length; j++) {
      r -= weights[j];
      if (r <= 0) return j;
    }
    return weights.length - 1;
  }

  // --- Popularity options ("Top X%" rank cutoffs / recording-count ranges) ---
  function getSortedTuneIds() {
    if (sortedTuneIds) return sortedTuneIds;
    var ids = [];
    for (var id in popularityData) {
      if (incipitsData && incipitsData[id] && incipitsData[id].type) ids.push(id);
    }
    ids.sort(function (a, b) { return popularityData[b] - popularityData[a]; });
    sortedTuneIds = ids;
    return ids;
  }
  function getSortedSets(src, dataset) {
    if (!sortedSetsCache[src]) {
      sortedSetsCache[src] = dataset.slice().sort(function (a, b) { return b.n - a.n; });
    }
    return sortedSetsCache[src];
  }
  // Number of candidate items an option yields (before rhythm/key/size filters).
  function optionPopulation(src, opt) {
    if (src === 'poptunes') return Math.ceil(opt.pct / 100 * getSortedTuneIds().length);
    var dataset = src === 'usersets' ? userSetsData : recordedSetsData;
    if (opt.pct != null) return Math.ceil(opt.pct / 100 * dataset.length);
    return dataset.filter(function (s) {
      return s.n >= opt.min && s.n <= opt.max;
    }).length;
  }
  // The set objects an option admits (top-X% slice, or count range).
  function setsForOption(src, dataset, opt) {
    if (opt.pct != null) {
      var sorted = getSortedSets(src, dataset);
      return sorted.slice(0, Math.ceil(opt.pct / 100 * sorted.length));
    }
    return dataset.filter(function (s) { return s.n >= opt.min && s.n <= opt.max; });
  }

  // Load a chunked per-setting file on demand, cache in memory.
  // full=true -> data/tunes/ (full ABC, all tunes); else data/incipits/
  // (incipits, multi-setting tunes only). Each entry is an array of
  // { meter, mode, abc } settings, ordered with the default setting first.
  async function loadSettingsChunk(chunkId, full) {
    var store = full ? tuneChunks : incipitChunks;
    if (store[chunkId]) return store[chunkId];
    var dir = full ? 'tunes' : 'incipits';
    var resp = await fetch('data/' + dir + '/' + chunkId + '.json');
    if (!resp.ok) throw new Error('Failed to load ' + dir + ' chunk ' + chunkId);
    store[chunkId] = await resp.json();
    return store[chunkId];
  }

  // All settings (array of { meter, mode, abc }) for a tune, in the requested
  // view (incipit or full), falling back to the thesession.org API.
  async function getTuneSettings(tuneId, full) {
    var tid = String(tuneId);
    var chunkId = Math.floor(parseInt(tid) / CHUNK_SIZE);
    var chunk = await loadSettingsChunk(chunkId, full);
    if (chunk[tid]) return chunk[tid];
    var d = await fetchTuneDetailAPI(tuneId);
    return [{ meter: d.meter, mode: d.mode, abc: d.abc }];
  }

  // Tune data for one setting. settingIdx 0 = default. Returns the chosen
  // setting plus settingCount/settingIdx so the UI can show "n / N" and cycle.
  // The default incipit (setting 0, not full) uses the in-memory combined
  // incipits.json — instant, no fetch — so the first render stays fast.
  async function getTuneData(tuneId, settingIdx, full) {
    var tid = String(tuneId);
    var meta = (incipitsData && incipitsData[tid]) || {};
    var ns = meta.ns || 1;
    settingIdx = settingIdx || 0;
    if (!full && settingIdx === 0 && meta.abc != null) {
      return {
        name: meta.name, type: meta.type, meter: meta.meter,
        mode: meta.mode, abc: meta.abc, settingCount: ns, settingIdx: 0
      };
    }
    var arr = await getTuneSettings(tuneId, full);
    var i = Math.min(settingIdx, arr.length - 1);
    var s = arr[i];
    return {
      name: meta.name || ('Tune #' + tuneId), type: meta.type || '',
      meter: s.meter, mode: s.mode, abc: s.abc,
      settingCount: Math.max(arr.length, ns), settingIdx: i
    };
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

  // --- "Always Change" keys: no two ADJACENT tunes share a mode (repeats are
  // allowed, just not in a row). ---

  // Can `size` items be chosen so no two adjacent share a mode? Feasible iff,
  // after capping each mode's usable count at ceil(size/2), enough remain.
  function canArrangeNoAdjacent(byKey, size) {
    if (size <= 0) return true;
    var cap = Math.ceil(size / 2), sum = 0;
    for (var m in byKey) sum += Math.min(byKey[m].length, cap);
    return sum >= size;
  }

  // Greedy fallback: at each step take from the most-abundant remaining mode
  // that isn't the previous one (the reorganize-string rule), so it succeeds
  // exactly when canArrangeNoAdjacent does. It oscillates between the two
  // biggest modes, so it's only a last resort for tight pools.
  function pickNoAdjacentGreedy(byKey, size) {
    var groups = Object.keys(byKey).map(function (m) {
      return { mode: m, items: pickRandomUnique(byKey[m], byKey[m].length) };
    });
    var picked = [], last = null;
    for (var s = 0; s < size; s++) {
      var best = null;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (g.items.length === 0 || g.mode === last) continue;
        if (!best || g.items.length > best.items.length ||
            (g.items.length === best.items.length && Math.random() < 0.5)) {
          best = g;
        }
      }
      if (!best) return null;
      picked.push(best.items.pop());
      last = best.mode;
    }
    return picked;
  }

  // "Always Change": the ONLY rule is that each tune's mode differs from the one
  // before it — no oscillation, no return-to-same stipulation. For variety we
  // pick the next mode UNIFORMLY among the available distinct modes (not weighted
  // by tune count, which would collapse to the dominant D/G), then a random tune
  // within it. Randomised with retries; a tight pool that keeps stranding falls
  // back to the feasibility-guaranteed greedy. Works for byKey of mode -> [items].
  function pickNoAdjacent(byKey, size) {
    var modes = Object.keys(byKey);
    for (var attempt = 0; attempt < 80; attempt++) {
      var remaining = {};
      for (var i = 0; i < modes.length; i++) remaining[modes[i]] = byKey[modes[i]].slice();
      var picked = [], last = null, ok = true;
      for (var s = 0; s < size; s++) {
        var cand = modes.filter(function (m) {
          return m !== last && remaining[m].length > 0;
        });
        if (cand.length === 0) { ok = false; break; }
        var mode = cand[Math.floor(Math.random() * cand.length)];
        var pool = remaining[mode];
        picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        last = mode;
      }
      if (ok && picked.length === size) return picked;
    }
    return pickNoAdjacentGreedy(byKey, size);
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
    if (kmode === 'change') {
      return canArrangeNoAdjacent(groupByKey(bucket), size);
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
    if (kmode === 'change') {
      return pickNoAdjacent(groupByKey(bucket), size);
    }
    return pickRandomUnique(bucket, size);
  }

  // --- Set picking ---
  function pickSet(selectedRhythm) {
    var buckets = bucketByRhythm();
    var size = effectiveSize();

    var weightedRhythms = [];
    for (var r in buckets) {
      if (rhythmEligible(buckets[r], size, keyMode)) {
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
      if (!buckets[chosenRhythm] || !rhythmEligible(buckets[chosenRhythm], size, keyMode)) {
        throw new Error('Not enough playable tunes for "' + chosenRhythm + '" with current settings.');
      }
    }

    var selected = pickFromBucket(buckets[chosenRhythm], size, keyMode);
    if (!selected) throw new Error('Could not pick a set with current settings.');
    return { rhythm: chosenRhythm, tunes: selected };
  }

  // Build a set-display tune object from a tune id, using incipit metadata.
  function tuneFromId(id) {
    var d = (incipitsData && incipitsData[String(id)]) || {};
    return {
      id: id,
      name: d.name || ('Tune #' + id),
      type: d.type || '',
      url: 'https://thesession.org/tunes/' + id,
      mode: d.mode || ''
    };
  }

  // Mode (key) of a tune id, from incipit metadata.
  function tuneMode(id) {
    var d = incipitsData && incipitsData[String(id)];
    return d ? d.mode : null;
  }

  // Does a set's tunes satisfy the current key mode?
  function setMatchesKey(ids) {
    if (keyMode === 'any') return true;
    var modes = ids.map(tuneMode);
    if (modes.some(function (m) { return !m; })) return false; // unknown key
    if (keyMode === 'same') {
      return modes.every(function (m) { return m === modes[0]; });
    }
    if (keyMode === 'change') {
      // No two adjacent tunes share a mode (non-adjacent repeats are fine).
      for (var c = 1; c < modes.length; c++) {
        if (modes[c] === modes[c - 1]) return false;
      }
      return true;
    }
    // 'different'
    var seen = {};
    for (var i = 0; i < modes.length; i++) {
      if (seen[modes[i]]) return false;
      seen[modes[i]] = true;
    }
    return true;
  }

  // Sets a source offers under the current popularity/size/key/only-known
  // settings, EXCLUDING the rhythm filter. Shared by counting and picking so
  // the dropdown numbers always match what Pick can actually produce.
  function setCandidates(src) {
    var base;
    if (src === 'mysets') {
      base = (mySetsData || []).slice();
    } else {
      var dataset = src === 'usersets' ? userSetsData : recordedSetsData;
      if (!dataset) return [];
      base = setsForOption(src, dataset, POP_OPTIONS[src][popIdxBySource[src]]);
    }
    var size = effectiveSize();
    if (size !== 'random') {
      base = base.filter(function (s) { return s.t.length === size; });
    }
    // "Only sets I fully know" applies to the global set sources (not own sets).
    if (src !== 'mysets' && onlyKnown && getLoadedMembers().length > 0) {
      var known = {};
      tunebook.forEach(function (t) { known[t.id] = true; });
      base = base.filter(function (s) {
        return s.t.every(function (id) { return known[id]; });
      });
    }
    if (keyMode !== 'any') {
      base = base.filter(function (s) { return setMatchesKey(s.t); });
    }
    return base;
  }

  // Tune ids in the selected poptunes top-X% pool, after the "only known" filter.
  function poptunesPoolIds() {
    if (!popularityData || !incipitsData) return [];
    var sorted = getSortedTuneIds();
    var opt = POP_OPTIONS.poptunes[popIdxBySource.poptunes];
    var poolIds = sorted.slice(0, Math.ceil(opt.pct / 100 * sorted.length));
    if (onlyKnown && getLoadedMembers().length > 0) {
      var known = {};
      tunebook.forEach(function (t) { known[t.id] = true; });
      poolIds = poolIds.filter(function (id) { return known[Number(id)]; });
    }
    return poolIds;
  }

  // --- Pick a pre-existing set (popular user sets / recorded medleys) ---
  function pickPopularSet(src) {
    var rhythm = rhythmSelect.value;
    var candidates = setCandidates(src);
    if (rhythm && rhythm !== 'random') {
      candidates = candidates.filter(function (s) { return s.r === rhythm; });
    }
    if (candidates.length === 0) {
      var loaded = getLoadedMembers().length > 0;
      throw new Error(loaded && onlyKnown
        ? 'No matching sets are fully in your tunebook. Try unticking "Only sets I fully know", or loosening the rhythm/size/key/popularity.'
        : 'No sets match the current rhythm/size/key/popularity settings.');
    }
    var chosen = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      rhythm: chosen.r || 'mixed',
      popularity: chosen.n,
      recs: chosen.recs,
      tunes: chosen.t.map(tuneFromId)
    };
  }

  // --- Pick from the loaded member's own thesession.org saved sets ---
  function pickMySet() {
    if (!mySetsData || mySetsData.length === 0) {
      throw new Error('No saved sets found. Load a member first — this uses their thesession.org saved sets.');
    }
    var rhythm = rhythmSelect.value;
    var candidates = setCandidates('mysets');
    if (rhythm && rhythm !== 'random') {
      candidates = candidates.filter(function (s) { return s.r === rhythm; });
    }
    if (candidates.length === 0) {
      throw new Error('None of your saved sets match the current rhythm/size/key settings.');
    }
    var chosen = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      rhythm: chosen.r || 'mixed',
      tunes: chosen.t.map(tuneFromId)
    };
  }

  // --- Pick a fresh set of popular tunes from the selected top-X% pool ---
  function pickPopularTunes() {
    // Take the top-X% most popular tunes, then group by rhythm type and mode.
    var size = effectiveSize();
    var poolIds = poptunesPoolIds();

    var byType = {};
    for (var pi = 0; pi < poolIds.length; pi++) {
      var id = poolIds[pi];
      var d = incipitsData[id];
      if (!byType[d.type]) byType[d.type] = { all: [], byMode: {} };
      byType[d.type].all.push(id);
      if (d.mode) {
        if (!byType[d.type].byMode[d.mode]) byType[d.type].byMode[d.mode] = [];
        byType[d.type].byMode[d.mode].push(id);
      }
    }

    // A type can yield a set under the current key mode if...
    function typeEligible(g) {
      if (keyMode === 'any') return g.all.length >= size;
      if (keyMode === 'same') {
        return Object.keys(g.byMode).some(function (m) {
          return g.byMode[m].length >= size;
        });
      }
      if (keyMode === 'change') return canArrangeNoAdjacent(g.byMode, size);
      return Object.keys(g.byMode).length >= size; // 'different'
    }

    var rhythm = rhythmSelect.value;
    var chosenType;
    if (!rhythm || rhythm === 'random') {
      var eligible = Object.keys(byType).filter(function (t) {
        return typeEligible(byType[t]);
      });
      if (eligible.length === 0) throw new Error('Not enough tunes for the current size/key/popularity settings.');
      chosenType = eligible[pickWeightedIndex(
        eligible.map(function (t) { return byType[t].all.length; }))];
    } else {
      chosenType = rhythm;
      if (!byType[chosenType] || !typeEligible(byType[chosenType])) {
        throw new Error('Not enough "' + chosenType + '" tunes for the current size/key/popularity settings.');
      }
    }

    var g = byType[chosenType];
    var ids;
    if (keyMode === 'same') {
      var modes = Object.keys(g.byMode).filter(function (m) {
        return g.byMode[m].length >= size;
      });
      var chosenMode = modes[pickWeightedIndex(
        modes.map(function (m) { return g.byMode[m].length; }))];
      ids = pickRandomUnique(g.byMode[chosenMode], size);
    } else if (keyMode === 'different') {
      // `size` distinct modes, then one random tune from each.
      var pickedModes = pickRandomUnique(Object.keys(g.byMode), size);
      ids = pickedModes.map(function (m) {
        return g.byMode[m][Math.floor(Math.random() * g.byMode[m].length)];
      });
    } else if (keyMode === 'change') {
      ids = pickNoAdjacent(g.byMode, size);
    } else {
      ids = pickRandomUnique(g.all, size);
    }
    return { rhythm: chosenType, tunes: ids.map(tuneFromId) };
  }

  // --- Reroll a single tune within the current set ---
  function rerollTune(idx) {
    if (!currentSet) return;
    var bucket;

    if (source === 'poptunes') {
      // Build pool the same way pickPopularTunes does.
      var poolIds = poptunesPoolIds();
      // Filter by rhythm
      bucket = poolIds.filter(function (id) {
        var d = incipitsData[id];
        return d && d.type === currentSet.rhythm;
      }).map(function (id) {
        var d = incipitsData[id];
        return { id: Number(id), name: d.name, type: d.type, mode: d.mode, url: 'https://thesession.org/tunes/' + id };
      });
    } else {
      // random: use tunebook buckets
      var buckets = bucketByRhythm();
      bucket = (buckets[currentSet.rhythm] || []).slice();
    }

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
    } else if (keyMode === 'change') {
      // Only the immediate neighbours' modes are off-limits.
      var neighbours = {};
      [idx - 1, idx + 1].forEach(function (n) {
        var t = currentSet.tunes[n];
        if (t && t.mode) neighbours[t.mode] = true;
      });
      bucket = bucket.filter(function (t) { return t.mode && !neighbours[t.mode]; });
    }

    if (bucket.length === 0) {
      alert('No replacement tune available with current settings.');
      return;
    }

    var newTune = bucket[Math.floor(Math.random() * bucket.length)];
    currentSet.tunes[idx] = newTune;
    renderSet(currentSet);
  }

  // --- UI: rhythm option counts for the active source ---
  // Available items per rhythm under the CURRENT settings (size/keys/popularity/
  // only-known), so the dropdown numbers reflect what Pick can produce.
  function rhythmCounts() {
    var out = {};
    if (source === 'random') {
      var buckets = bucketByRhythm();
      for (var r in buckets) out[r] = buckets[r].length;
    } else if (source === 'poptunes') {
      poptunesPoolIds().forEach(function (id) {
        var d = incipitsData[id];
        if (d && d.type) out[d.type] = (out[d.type] || 0) + 1;
      });
    } else {
      // usersets / recordings / mysets
      setCandidates(source).forEach(function (s) {
        if (s.r) out[s.r] = (out[s.r] || 0) + 1;
      });
    }
    return out;
  }

  // --- UI: populate rhythm dropdown ---
  function updateRhythmDropdown() {
    var counts = rhythmCounts();
    var prev = rhythmSelect.value;
    rhythmSelect.innerHTML = '<option value="random">Random</option>';

    // Pre-existing sets are not gated by size; tune modes need >= size candidates.
    var min = isPreExisting(source) ? 1 : effectiveSize();

    var types = Object.keys(counts).sort();
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var count = counts[type];
      var opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type.charAt(0).toUpperCase() + type.slice(1) + ' (' + count + ')';
      if (count < min) opt.disabled = true;
      rhythmSelect.appendChild(opt);
    }

    // Preserve user's previous choice if still available and pickable
    var stillPickable = Array.prototype.some.call(rhythmSelect.options, function (o) {
      return o.value === prev && !o.disabled;
    });
    if (prev && stillPickable) rhythmSelect.value = prev;
  }

  // Effective size for the active source: pre-existing-set sources may use the
  // "random" (any-length) override; everything else uses the numeric size.
  function effectiveSize() {
    return (isPreExisting(source) && sizeAny) ? 'random' : sizeNumeric;
  }

  // --- UI: reflect the effective size in the size button group ---
  function updateSizeButtons() {
    var eff = String(effectiveSize());
    sizeButtons.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.size === eff);
    });
  }

  // Sources whose sets are pre-existing (variable length, no reroll).
  function isPreExisting(src) {
    return src === 'usersets' || src === 'recordings' || src === 'mysets';
  }

  // --- UI: update source button availability ---
  function updateSourceAvailability() {
    var loaded = getLoadedMembers().length > 0;
    var tier1Buttons = sourceButtonsTier1.querySelectorAll('button');
    tier1Buttons.forEach(function (b) {
      b.disabled = !loaded;
    });
    sourceUnavailableMsg.style.display = loaded ? 'none' : '';
  }

  // --- UI: show/hide control rows for the active source ---
  function updateControlVisibility() {
    var loaded = getLoadedMembers().length > 0;
    // Size and Keys apply to every source; pre-existing sets also offer "Random" size.
    randomSizeBtn.style.display = isPreExisting(source) ? '' : 'none';
    popularityRow.style.display = POP_OPTIONS[source] ? '' : 'none';
    // "Only what I know" applies to popular/recorded sets and popular tunes.
    var showKnown = loaded &&
      (source === 'usersets' || source === 'recordings' || source === 'poptunes');
    knownRow.style.display = showKnown ? '' : 'none';
    updateSourceAvailability();
  }

  // --- UI: render the popularity options for the active source ---
  function renderPopularityButtons() {
    popularityButtons.innerHTML = '';
    if (!POP_OPTIONS[source]) return;
    var opts = POP_OPTIONS[source];
    var unit = source === 'poptunes' ? 'tunes'
      : (source === 'recordings' ? 'medleys' : 'sets');
    opts.forEach(function (o, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.idx = String(i);
      b.textContent = o.label;
      var n = optionPopulation(source, o);
      b.title = '≈' + n.toLocaleString() + ' ' + unit;
      if (n === 0) b.disabled = true;
      if (i === popIdxBySource[source]) b.classList.add('active');
      popularityButtons.appendChild(b);
    });
  }

  // --- Switch source: load needed data, refresh controls ---
  async function applySource() {
    updateControlVisibility();
    try {
      if (source === 'usersets') await loadUserSets();
      else if (source === 'recordings') await loadRecordedSets();
      else if (source === 'poptunes') { await loadPopularity(); await loadIncipitsData(); }
      else if (source === 'mysets') { await loadIncipitsData(); await ensureMySets(); }
    } catch (e) {
      alert('Could not load data for this source: ' + e.message);
    }
    updateSizeButtons();
    renderPopularityButtons();
    updateRhythmDropdown();
  }

  // Whether a tune should render in full: a per-tune override wins, else the
  // global "All Full" state.
  function effectiveFull(tune) {
    return (tune.full !== undefined) ? tune.full : showFullTunes;
  }

  // Cards are found by data-idx (not fixed ids) so partial re-renders survive
  // drag reordering, which renumbers data-idx in onEnd.
  function tuneCard(idx) {
    return setDisplay.querySelector('#tuneList .tune-card[data-idx="' + idx + '"]');
  }

  function updateFullBtn(card, full) {
    var btn = card.querySelector('.full-btn');
    if (btn) btn.classList.toggle('on', !!full);
  }

  // The "Setting n / N" line with prev/next nav, beneath the tune name. Hidden
  // for single-setting tunes.
  function updateSettingIndicator(card, cur, count) {
    var el = card.querySelector('.tune-setting');
    if (!el) return;
    if (!count || count < 2) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML =
      '<button class="setting-nav" data-dir="-1" title="Previous setting">‹</button>' +
      '<span class="setting-num">Setting ' + (cur + 1) + ' / ' + count + '</span>' +
      '<button class="setting-nav" data-dir="1" title="Next setting">›</button>';
  }

  // Render (or re-render) the notation, key and setting indicator for one card.
  function renderTuneNotation(idx) {
    var card = tuneCard(idx);
    if (!card) return Promise.resolve();
    var tune = currentSet.tunes[idx];
    // Apply a remembered setting choice for this tune the first time it renders.
    if (tune.settingIdx == null && settingChoices[String(tune.id)] != null) {
      tune.settingIdx = settingChoices[String(tune.id)];
    }
    var abcDiv = card.querySelector('.abc-render');

    // "Name only" overrides everything: just the title, no notation/key/setting.
    if (nameOnly) {
      abcDiv.innerHTML = '';
      var keyOff = card.querySelector('.tune-key');
      if (keyOff) keyOff.textContent = '';
      updateSettingIndicator(card, 0, 1);
      return Promise.resolve();
    }

    var full = effectiveFull(tune);
    abcDiv.textContent = 'Loading notation...';
    updateFullBtn(card, full);
    return getTuneData(tune.id, tune.settingIdx || 0, full).then(function (d) {
      // Store mode/setting on the tune object for save/download and cycling.
      tune.mode = d.mode;
      tune.settingCount = d.settingCount;
      tune.settingIdx = d.settingIdx;
      ABCJS.renderAbc(abcDiv, buildABCString(d), { responsive: 'resize' });
      var keyEl = card.querySelector('.tune-key');
      if (keyEl) keyEl.textContent = ' — ' + formatKeyDisplay(d.mode);
      updateSettingIndicator(card, d.settingIdx, d.settingCount);
    }).catch(function (e) {
      abcDiv.textContent = 'Failed to load notation: ' + e.message;
    });
  }

  // Step a single tune to its previous/next setting (display only — the set's
  // key logic stays fixed on each tune's default setting). The choice is
  // remembered so the tune defaults to it next time.
  function cycleSetting(idx, dir) {
    var tune = currentSet.tunes[idx];
    var n = tune.settingCount || 1;
    if (n < 2) return;
    tune.settingIdx = (((tune.settingIdx || 0) + dir) % n + n) % n;
    if (tune.settingIdx === 0) delete settingChoices[String(tune.id)];
    else settingChoices[String(tune.id)] = tune.settingIdx;
    saveSettingChoices();
    renderTuneNotation(idx);
  }

  // --- UI: render set ---
  async function renderSet(set) {
    var note = set.note ? ' <span class="set-note">' + set.note + '</span>' : '';
    setDisplay.innerHTML =
      '<div class="set-header"><h3>' + set.rhythm + ' set' + note + '</h3></div>' +
      '<div class="set-controls">' +
        '<div class="full-controls">' +
          '<button class="name-only-btn toggle-btn' + (nameOnly ? ' on' : '') +
            '" title="Show tune names only, no notation">Name only</button>' +
          '<button class="all-full-btn toggle-btn' + (showFullTunes ? ' on' : '') +
            '" title="Show every tune in full">All Full</button>' +
        '</div>' +
        '<button class="mark-all-played-btn"' + (setCommitted ? ' disabled' : '') + '>' +
          '&#10004; Mark All Played</button>' +
      '</div>';

    var list = document.createElement('div');
    list.id = 'tuneList';
    list.classList.toggle('name-only', nameOnly); // compact cards, no notation
    setDisplay.appendChild(list);

    for (var i = 0; i < set.tunes.length; i++) {
      var tune = set.tunes[i];
      var card = document.createElement('div');
      card.className = 'tune-card';
      card.dataset.idx = i;

      var dis = setCommitted ? ' disabled' : '';
      // Reroll only makes sense for tunebook-random sets and popular tunes;
      // pre-existing sets (popular/recorded) are shown intact.
      var rerollHtml = (source === 'random' || source === 'poptunes')
        ? '<button class="reroll-btn" data-idx="' + i + '"' + dis + ' title="Replace with a new random tune">&#8634; Reroll</button>'
        : '';

      var header = document.createElement('div');
      header.className = 'tune-header';
      header.innerHTML =
        '<span class="drag-handle">&#9776;</span>' +
        '<span class="tune-info">' +
          '<span class="tune-title">' +
            '<a href="' + tune.url + '" target="_blank">' + tune.name + '</a>' +
            '<span class="tune-key"></span>' +
          '</span>' +
          '<span class="tune-setting" style="display:none"></span>' +
        '</span>' +
        '<button class="full-btn toggle-btn" title="Show this tune in full">Full</button>' +
        rerollHtml +
        '<button class="mark-played-btn" data-tune-id="' + tune.id + '" data-idx="' + i + '"' + dis + '>' +
          '&#10004; Played</button>';
      card.appendChild(header);

      var abcDiv = document.createElement('div');
      abcDiv.className = 'abc-render';
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
        list.querySelectorAll('.tune-card').forEach(function (card, newIdx) {
          card.dataset.idx = newIdx;
          var rerollBtn = card.querySelector('.reroll-btn');
          if (rerollBtn) rerollBtn.dataset.idx = newIdx;
          var playedBtn = card.querySelector('.mark-played-btn');
          if (playedBtn) playedBtn.dataset.idx = newIdx;
        });
      }
    });

    // Recording details (bonus, for recorded sets only).
    if (set.recs && set.recs.length) {
      var rec = document.createElement('div');
      rec.className = 'rec-details';
      var label = document.createElement('strong');
      label.textContent = 'Recorded on: ';
      rec.appendChild(label);
      rec.appendChild(document.createTextNode(set.recs.join(' · ')));
      setDisplay.appendChild(rec);
    }

    await Promise.all(set.tunes.map(function (_, idx) {
      return renderTuneNotation(idx);
    }));
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

    // If no member was loaded yet, clear any stale set display.
    if (!getLoadedMembers().length) {
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
      rowReloadBtn.style.display = result.fromCache ? '' : 'none';
      renderAllRecentUsers();
      mySetsMemberId = null; // primary member may have changed
      updateControlVisibility();
      if (source === 'mysets') applySource(); else updateRhythmDropdown();
      updateSavedSetsButtons();

      // Fetch the member's saved sets in the background (cache-aware), so the
      // set count shows and "My sets" is ready.
      (async function () {
        try {
          var cacheKey = 'mysets:' + resolvedId;
          var raw = forceReload ? null : await dbGet(cacheKey);
          if (!raw) { raw = await fetchMemberSets(resolvedId); await dbSet(cacheKey, raw); }
          members[rowIndex].sets = parseMemberSets(raw);
          updateTunebookInfo();
          if (source === 'mysets') { mySetsMemberId = null; applySource(); }
        } catch (e) {
          // Silently handle failure — the rest of the app still works.
        }
      })();

      updateTunebookInfo();
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
    if (e.target.closest('.find-member-btn')) {
      openLocationModal(rowIndex, 'name');
      return;
    }

    var chip = e.target.closest('.user-chip');
    if (chip && !chip.disabled) {
      row.querySelector('.member-input').value = chip.dataset.id;
      handleRowLoad(rowIndex, false);
    }
  });

  addMemberBtn.addEventListener('click', function () { addMemberRow(); });

  // --- Find a member by name or location (thesession.org + OSM geocoding) ---
  var locationRowIndex = null;
  // { label, fetchPage(page)->Promise, lat, lon (optional), page, pages, members:[] }
  var locSearch = null;

  function openLocationModal(rowIndex, focusMode) {
    locationRowIndex = rowIndex;
    locSearch = null;
    locationResults.innerHTML = '';
    locationStatus.textContent = '';
    locationNameFilter.value = '';
    locationNameFilter.style.display = 'none';
    locationMore.style.display = 'none';
    locationModal.style.display = 'flex';
    (focusMode === 'name' ? memberNameInput : locationPlaceInput).focus();
  }

  function closeLocation() { locationModal.style.display = 'none'; }

  // Distance in km between two lat/lon points (haversine).
  function distanceKm(lat1, lon1, lat2, lon2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Geocode a place name to {lat, lon, label} via OpenStreetMap Nominatim.
  async function geocode(place) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
      encodeURIComponent(place);
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('Geocoding failed (' + resp.status + ')');
    var data = await resp.json();
    if (!data.length) throw new Error('No place found for "' + place + '".');
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      label: data[0].display_name
    };
  }

  // Reverse-geocode lat/lon to a human place name (sanity check for "my location").
  async function reverseGeocode(lat, lon) {
    try {
      var url = 'https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=' +
        lat + '&lon=' + lon;
      var data = await (await fetch(url)).json();
      return data.display_name || (lat.toFixed(3) + ', ' + lon.toFixed(3));
    } catch (e) {
      return lat.toFixed(3) + ', ' + lon.toFixed(3);
    }
  }

  async function fetchJSON(url) {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('Member search failed (' + resp.status + ')');
    return resp.json();
  }
  function fetchNearbyPage(lat, lon, page) {
    return fetchJSON('https://thesession.org/members/nearby?format=json&page=' + page +
      '&latlon=' + lat + ',' + lon);
  }
  function fetchNamePage(name, page) {
    return fetchJSON('https://thesession.org/members/search?format=json&perpage=10&page=' +
      page + '&q=' + encodeURIComponent(name));
  }

  // Begin a search. `opts`: { label, fetchPage(page), lat?, lon? }.
  async function startSearch(opts) {
    locSearch = {
      label: opts.label, fetchPage: opts.fetchPage,
      lat: opts.lat, lon: opts.lon, page: 0, pages: 1, members: []
    };
    locationResults.innerHTML = '';
    locationNameFilter.style.display = 'none';
    locationMore.style.display = 'none';
    await loadNextLocationPage();
  }

  async function loadNextLocationPage() {
    if (!locSearch) return;
    locationStatus.textContent = 'Searching ' + locSearch.label + '…';
    try {
      var data = await locSearch.fetchPage(locSearch.page + 1);
      locSearch.page = data.page;
      locSearch.pages = data.pages;
      locSearch.members = locSearch.members.concat(data.members || []);
      if (locSearch.members.length === 0) {
        locationStatus.textContent = 'No members found for ' + locSearch.label + '.';
        return;
      }
      locationStatus.textContent = data.total + ' member' + (data.total === 1 ? '' : 's') +
        ' for ' + locSearch.label + '. Pick yourself or a friend:';
      locationNameFilter.style.display = '';
      renderLocationResults();
    } catch (e) {
      locationStatus.textContent = e.message;
    }
  }

  function renderLocationResults() {
    var filter = locationNameFilter.value.trim().toLowerCase();
    locationResults.innerHTML = '';
    var shown = 0;
    locSearch.members.forEach(function (m) {
      if (filter && m.name.toLowerCase().indexOf(filter) === -1) return;
      shown++;
      var item = document.createElement('div');
      item.className = 'location-result';
      item.dataset.id = m.id;

      var dist = '';
      if (locSearch.lat != null && m.location && m.location.latitude) {
        var km = distanceKm(locSearch.lat, locSearch.lon,
          parseFloat(m.location.latitude), parseFloat(m.location.longitude));
        dist = ' — ' + (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
      }
      var bio = m.bio ? m.bio.trim().replace(/\s+/g, ' ').slice(0, 90) : '';

      item.innerHTML =
        '<span class="loc-name">' + m.name + '</span>' +
        '<span class="loc-meta">#' + m.id + dist + '</span>' +
        (bio ? '<span class="loc-bio">' + bio + '</span>' : '');
      locationResults.appendChild(item);
    });

    if (shown === 0) {
      locationResults.innerHTML = '<div class="location-empty">No loaded results match "' +
        filter + '". Try Load more.</div>';
    }
    locationMore.style.display = (locSearch.page < locSearch.pages) ? '' : 'none';
  }

  memberNameSearchBtn.addEventListener('click', function () {
    var name = memberNameInput.value.trim();
    if (!name) { memberNameInput.focus(); return; }
    startSearch({
      label: 'name "' + name + '"',
      fetchPage: function (p) { return fetchNamePage(name, p); }
    });
  });

  memberNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') memberNameSearchBtn.click();
  });

  locationSearchBtn.addEventListener('click', async function () {
    var place = locationPlaceInput.value.trim();
    if (!place) { locationPlaceInput.focus(); return; }
    locationStatus.textContent = 'Looking up "' + place + '"…';
    try {
      var geo = await geocode(place);
      await startSearch({
        label: 'near ' + geo.label, lat: geo.lat, lon: geo.lon,
        fetchPage: function (p) { return fetchNearbyPage(geo.lat, geo.lon, p); }
      });
    } catch (e) {
      locationStatus.textContent = e.message;
    }
  });

  locationPlaceInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') locationSearchBtn.click();
  });

  locationGeoBtn.addEventListener('click', function () {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Geolocation is not available in this browser.';
      return;
    }
    locationStatus.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(async function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var place = await reverseGeocode(lat, lon);
      locationPlaceInput.value = place;
      await startSearch({
        label: 'near ' + place + ' (your location)', lat: lat, lon: lon,
        fetchPage: function (p) { return fetchNearbyPage(lat, lon, p); }
      });
    }, function () {
      locationStatus.textContent = 'Could not get your location (permission denied?).';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  });

  locationNameFilter.addEventListener('input', function () {
    if (locSearch) renderLocationResults();
  });

  locationMore.addEventListener('click', function () { loadNextLocationPage(); });

  locationResults.addEventListener('click', function (e) {
    var item = e.target.closest('.location-result');
    if (!item || locationRowIndex === null) return;
    var row = getRow(locationRowIndex);
    if (row) row.querySelector('.member-input').value = item.dataset.id;
    closeLocation();
    handleRowLoad(locationRowIndex, false);
  });

  closeLocationModal.addEventListener('click', closeLocation);
  locationModal.addEventListener('click', function (e) {
    if (e.target === locationModal) closeLocation();
  });

  // --- Event: Source buttons (two tiers) ---
  function setSourceActive(src) {
    [sourceButtonsTier1, sourceButtonsTier2].forEach(function (grp) {
      grp.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', b.dataset.source === src);
      });
    });
  }
  function handleSourceClick(e) {
    var btn = e.target.closest('button[data-source]');
    if (!btn || btn.disabled) return;
    source = btn.dataset.source;
    setSourceActive(source);
    savePrefs();
    applySource();
  }
  sourceButtonsTier1.addEventListener('click', handleSourceClick);
  sourceButtonsTier2.addEventListener('click', handleSourceClick);

  // --- Collapsible sections (Load tunebooks / Settings) ---
  function setCollapsed(section, headerBtn, collapsed) {
    section.classList.toggle('collapsed', collapsed);
    var ind = headerBtn.querySelector('.section-toggle');
    if (ind) ind.textContent = collapsed ? '▸' : '▾'; // ▸ / ▾
  }
  function wireCollapsible(headerBtn, section) {
    headerBtn.addEventListener('click', function () {
      setCollapsed(section, headerBtn, !section.classList.contains('collapsed'));
      savePrefs();
    });
  }
  wireCollapsible(tunebookHeaderBtn, tunebookSection);
  wireCollapsible(settingsHeaderBtn, settingsSection);

  // --- Event: Popularity option buttons (remembered per source) ---
  popularityButtons.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-idx]');
    if (!btn || btn.disabled) return;
    popIdxBySource[source] = Number(btn.dataset.idx);
    popularityButtons.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    savePrefs();
    updateRhythmDropdown();
  });

  // --- Event: Only-known toggle ---
  onlyKnownToggle.addEventListener('change', function () {
    onlyKnown = onlyKnownToggle.checked;
    savePrefs();
    updateRhythmDropdown();
  });

  // --- Event: Size buttons ---
  sizeButtons.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-size]');
    if (!btn) return;
    if (btn.dataset.size === 'random') sizeAny = true;
    else { sizeNumeric = Number(btn.dataset.size); sizeAny = false; }
    updateSizeButtons();
    savePrefs();
    updateRhythmDropdown();
  });

  // --- Event: Key mode buttons (remembered across sources) ---
  keyButtons.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-key]');
    if (!btn) return;
    keyMode = btn.dataset.key;
    keyButtons.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    savePrefs();
    updateRhythmDropdown();
  });

  // --- Event: Pick set ---
  pickBtn.addEventListener('click', async function () {
    try {
      await loadIncipitsData();
      if (source === 'random') {
        if (getLoadedMembers().length === 0) {
          throw new Error('Load a tunebook first, or choose a different Source.');
        }
        currentSet = pickSet(rhythmSelect.value);
      } else if (source === 'usersets') {
        await loadUserSets();
        currentSet = pickPopularSet('usersets');
        currentSet.note = 'saved by ' + currentSet.popularity +
          ' user' + (currentSet.popularity === 1 ? '' : 's');
      } else if (source === 'recordings') {
        await loadRecordedSets();
        currentSet = pickPopularSet('recordings');
        currentSet.note = 'recorded ' + currentSet.popularity +
          ' time' + (currentSet.popularity === 1 ? '' : 's');
      } else if (source === 'poptunes') {
        await loadPopularity();
        currentSet = pickPopularTunes();
      } else if (source === 'mysets') {
        await ensureMySets();
        currentSet = pickMySet();
      }
      setCommitted = false;
      saveBtn.disabled = false;
      await renderSet(currentSet);
    } catch (e) {
      alert(e.message);
    }
  });

  // --- Event: Save set ---
  saveBtn.addEventListener('click', function () {
    if (!currentSet) return;

    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    savedSets.push({
      date: new Date().toISOString(),
      rhythm: currentSet.rhythm,
      tunes: currentSet.tunes.map(function (t) {
        return { id: t.id, name: t.name, type: t.type, mode: t.mode || '' };
      })
    });
    localStorage.setItem('sets:' + memberId, JSON.stringify(savedSets));

    commitSet(true);
    updateSavedSetsButtons();
  });

  // --- Mark every tune in the current set as played, locking the set ---
  // lockSave: only Save itself disables the Save button. "Mark All Played"
  // marks the tunes and locks the per-tune controls but leaves Save available,
  // so a marked set can still be saved afterwards.
  function commitSet(lockSave) {
    if (!currentSet) return;
    currentSet.tunes.forEach(function (t) { markTunePlayed(t.id); });
    setCommitted = true;
    if (lockSave) saveBtn.disabled = true;
    document.querySelectorAll('.mark-played-btn, .reroll-btn, .mark-all-played-btn')
      .forEach(function (b) { b.disabled = true; });
    updateRhythmDropdown();
  }

  // --- Saved sets helpers ---
  function updateSavedSetsButtons() {
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    var hasSaved = savedSets.length > 0;
    chooseSavedBtn.disabled = !hasSaved;
    if (downloadSavedBtn) downloadSavedBtn.disabled = !hasSaved;
  }

  function formatSavedDate(dateStr) {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // (Re)build the saved-sets modal list from localStorage.
  function renderSavedSetsList() {
    var savedSets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
    savedSetsList.innerHTML = '';
    for (var i = 0; i < savedSets.length; i++) {
      var set = savedSets[i];
      var item = document.createElement('div');
      item.className = 'saved-set-item';
      item.dataset.index = i;

      var tuneNames = set.tunes.map(function (t) { return t.name; }).join(', ');
      item.innerHTML =
        '<div class="saved-set-info">' +
          '<strong>' + formatSavedDate(set.date) + '</strong> \u2014 ' +
          set.rhythm + ' set<br>' +
          '<span class="saved-set-tunes">' + tuneNames + '</span>' +
        '</div>' +
        '<button class="delete-set-btn" data-index="' + i +
          '" title="Delete this saved set">\u00d7</button>';
      savedSetsList.appendChild(item);
    }
    return savedSets.length;
  }

  // --- Event: Choose from Saved Sets ---
  chooseSavedBtn.addEventListener('click', function () {
    if (renderSavedSetsList() === 0) { alert('No saved sets.'); return; }
    savedSetsModal.style.display = 'flex';
  });

  savedSetsList.addEventListener('click', function (e) {
    // Delete (red \u00d7) \u2014 handled before the load-on-click below.
    var delBtn = e.target.closest('.delete-set-btn');
    if (delBtn) {
      var di = parseInt(delBtn.dataset.index);
      var sets = JSON.parse(localStorage.getItem('sets:' + memberId) || '[]');
      if (di >= 0 && di < sets.length &&
          confirm('Delete this saved set? This cannot be undone.')) {
        sets.splice(di, 1);
        localStorage.setItem('sets:' + memberId, JSON.stringify(sets));
        updateSavedSetsButtons();
        if (renderSavedSetsList() === 0) savedSetsModal.style.display = 'none';
      }
      return;
    }

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
    setCommitted = false;
    saveBtn.disabled = true;
    renderSet(currentSet);
  });

  closeSavedModal.addEventListener('click', function () {
    savedSetsModal.style.display = 'none';
  });

  savedSetsModal.addEventListener('click', function (e) {
    if (e.target === savedSetsModal) savedSetsModal.style.display = 'none';
  });

  // --- Event: Download Saved Sets (button may be absent) ---
  if (downloadSavedBtn) downloadSavedBtn.addEventListener('click', function () {
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

  // --- Event: PDF of the current set, honouring the on-screen display ---
  function capitalizeWords(s) {
    return (s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Render an SVG into the jsPDF doc via svg2pdf (method form or global form).
  function svgToDoc(doc, svg, opts) {
    if (typeof doc.svg === 'function') return doc.svg(svg, opts);
    if (typeof window.svg2pdf === 'function') {
      return Promise.resolve(window.svg2pdf(svg, doc, opts));
    }
    throw new Error('SVG-to-PDF support not available.');
  }

  // Builds the PDF from the SVGs already rendered on screen, so it matches the
  // current display (Name only / incipit / Full, including per-tune choices and
  // the chosen setting).
  async function exportSetPDF() {
    if (!currentSet || !currentSet.tunes || !currentSet.tunes.length) {
      alert('Pick or choose a set first, then export it to PDF.');
      return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert('PDF library failed to load.');
      return;
    }
    // Open the tab now (synchronously, in the click) so it isn't popup-blocked.
    var tab = window.open('', '_blank');
    if (tab) {
      tab.document.write('<title>Generating PDF…</title>' +
        '<p style="font-family:sans-serif;margin:2em">Generating PDF…</p>');
    }
    try {
      var JsPDF = window.jspdf.jsPDF;
      var doc = new JsPDF({ unit: 'pt', format: 'a4' });
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = doc.internal.pageSize.getHeight();
      var margin = 40;
      var y = margin;

      doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
      doc.text(capitalizeWords(currentSet.rhythm) + ' set', margin, y);
      y += 26;

      var maxW = pageW - margin * 2;
      var cards = setDisplay.querySelectorAll('#tuneList .tune-card');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var nameEl = card.querySelector('.tune-title a');
        var keyEl = card.querySelector('.tune-key');
        var title = (i + 1) + '. ' + (nameEl ? nameEl.textContent : 'Tune') +
          (keyEl && keyEl.textContent ? keyEl.textContent : '');

        // Measure the notation first so the title can stay with it across pages.
        var svg = card.querySelector('.abc-render svg');
        var w = 0, h = 0;
        if (svg) {
          var vb = svg.viewBox && svg.viewBox.baseVal;
          var rect = svg.getBoundingClientRect();
          var sw = (vb && vb.width) || rect.width || 1;
          var sh = (vb && vb.height) || rect.height || 1;
          w = maxW;
          h = sh * (w / sw);
          if (h > pageH - margin * 2) { // scale a tall tune down to one page
            var sc = (pageH - margin * 2) / h; h *= sc; w *= sc;
          }
        }

        doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
        var titleLines = doc.splitTextToSize(title, maxW); // wrap long names
        var titleH = titleLines.length * 16;

        // Page-break before the title if the title + its notation won't fit in
        // the remaining space (unless we're already at the top of a page).
        var blockH = titleH + (svg ? h + 18 : 6);
        if (y > margin && y + Math.min(blockH, pageH - margin * 2) > pageH - margin) {
          doc.addPage(); y = margin;
        }
        doc.text(titleLines, margin, y);
        y += titleH;

        if (svg) {
          if (y + h > pageH - margin) { doc.addPage(); y = margin; }
          await svgToDoc(doc, svg, { x: margin, y: y, width: w, height: h });
          y += h + 18;
        } else {
          y += 6;
        }
      }

      var url = doc.output('bloburl');
      if (tab) {
        tab.location.href = url;
      } else if (!window.open(url, '_blank')) {
        // Popups blocked and no pre-opened tab — fall back to a download.
        doc.save((currentSet.rhythm || 'set') + '.pdf');
      }
      // Free the blob once the new tab has had time to load it.
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) {
      if (tab) {
        try {
          tab.document.body.innerHTML =
            '<p style="font-family:sans-serif;margin:2em">Could not generate PDF: ' +
            e.message + '</p>';
        } catch (er) { /* cross-origin blob tab, ignore */ }
      }
      alert('Could not generate PDF: ' + e.message);
    }
  }

  if (pdfBtn) pdfBtn.addEventListener('click', exportSetPDF);

  // Index of the tune card an event happened in (survives drag reordering).
  function cardIdx(el) {
    var card = el.closest('.tune-card');
    return card ? Number(card.dataset.idx) : -1;
  }

  // --- Event delegation: full toggles / setting nav / mark played / reroll ---
  setDisplay.addEventListener('click', function (e) {
    // "Name only": global override — hide all notation, show titles only.
    var nameOnlyBtn = e.target.closest('.name-only-btn');
    if (nameOnlyBtn) {
      nameOnly = !nameOnly;
      savePrefs();
      // Full re-render: this rebuilds the list with the correct `name-only`
      // class (compact cards), the same path used when picking with it on.
      if (currentSet) renderSet(currentSet);
      return;
    }

    // "All Full": flip the global state, drop per-tune overrides, re-render all.
    var allFullBtn = e.target.closest('.all-full-btn');
    if (allFullBtn) {
      showFullTunes = !showFullTunes;
      currentSet.tunes.forEach(function (t) { delete t.full; });
      savePrefs();
      allFullBtn.classList.toggle('on', showFullTunes);
      currentSet.tunes.forEach(function (_, i) { renderTuneNotation(i); });
      return;
    }

    // Per-tune "Full": override just this tune.
    var fullBtn = e.target.closest('.full-btn');
    if (fullBtn) {
      var fi = cardIdx(fullBtn);
      if (fi >= 0) {
        var t = currentSet.tunes[fi];
        t.full = !effectiveFull(t);
        renderTuneNotation(fi);
      }
      return;
    }

    // Setting nav arrows (prev/next setting).
    var navBtn = e.target.closest('.setting-nav');
    if (navBtn) {
      var ni = cardIdx(navBtn);
      if (ni >= 0) cycleSetting(ni, Number(navBtn.dataset.dir));
      return;
    }

    var allBtn = e.target.closest('.mark-all-played-btn');
    if (allBtn && !allBtn.disabled) {
      commitSet();
      return;
    }

    var playedBtn = e.target.closest('.mark-played-btn');
    if (playedBtn && !playedBtn.disabled) {
      var tuneId = Number(playedBtn.dataset.tuneId);
      markTunePlayed(tuneId);
      playedBtn.disabled = true;
      playedBtn.textContent = '\u2714 Done';
      updateRhythmDropdown();
      return;
    }

    var rerollBtn = e.target.closest('.reroll-btn');
    if (rerollBtn && !rerollBtn.disabled) {
      var idx = Number(rerollBtn.dataset.idx);
      rerollTune(idx);
    }
  });

  // --- Swipe left/right on a tune's notation to cycle its settings ---
  var swipeX = null, swipeY = null, swipeIdx = -1;
  setDisplay.addEventListener('touchstart', function (e) {
    var card = e.target.closest('.tune-card');
    if (!card) { swipeIdx = -1; return; }
    swipeX = e.changedTouches[0].clientX;
    swipeY = e.changedTouches[0].clientY;
    swipeIdx = Number(card.dataset.idx);
  }, { passive: true });
  setDisplay.addEventListener('touchend', function (e) {
    if (swipeIdx < 0 || swipeX == null) return;
    var dx = e.changedTouches[0].clientX - swipeX;
    var dy = e.changedTouches[0].clientY - swipeY;
    var idx = swipeIdx;
    swipeX = swipeY = null; swipeIdx = -1;
    // Mostly-horizontal, deliberate swipe only (don't fight vertical scroll).
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    cycleSetting(idx, dx < 0 ? 1 : -1); // swipe left -> next setting
  }, { passive: true });

  // --- Init ---
  members.push({ id: null, name: null, tunebook: null, loaded: false });
  membersList.appendChild(createMemberRow(0));

  var lastMid = localStorage.getItem('lastMemberId');
  if (lastMid) getRow(0).querySelector('.member-input').value = lastMid;

  renderRecentUsersForRow(0);
  loadSettingChoices();

  // Restore cached picker preferences.
  (function applyPrefs() {
    var p = loadPrefs();
    if (typeof p.sizeNumeric === 'number') sizeNumeric = p.sizeNumeric;
    if (typeof p.sizeAny === 'boolean') sizeAny = p.sizeAny;
    if (p.keyMode) keyMode = p.keyMode;
    if (typeof p.onlyKnown === 'boolean') onlyKnown = p.onlyKnown;
    if (typeof p.showFull === 'boolean') showFullTunes = p.showFull;
    if (typeof p.nameOnly === 'boolean') nameOnly = p.nameOnly;
    if (p.popIdx) {
      ['poptunes', 'usersets', 'recordings'].forEach(function (k) {
        if (typeof p.popIdx[k] === 'number') popIdxBySource[k] = p.popIdx[k];
      });
    }
    if (p.source && document.querySelector('[data-source="' + p.source + '"]')) {
      source = p.source;
    }
    // "My…" sources need a loaded tunebook; none at startup, so fall back.
    if ((source === 'random' || source === 'mysets') && getLoadedMembers().length === 0) {
      source = 'poptunes';
    }
    setSourceActive(source);
    keyButtons.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.key === keyMode);
    });
    onlyKnownToggle.checked = onlyKnown;
    // Both sections default to collapsed (markup); restore any saved state.
    if (typeof p.tunebookCollapsed === 'boolean') {
      setCollapsed(tunebookSection, tunebookHeaderBtn, p.tunebookCollapsed);
    }
    if (typeof p.settingsCollapsed === 'boolean') {
      setCollapsed(settingsSection, settingsHeaderBtn, p.settingsCollapsed);
    }
  })();

  applySource(); // sets control visibility, size/popularity buttons, rhythm list

  // Pre-load incipits data in background
  loadIncipitsData().catch(function (e) {
    console.warn('Failed to pre-load incipits:', e.message);
  });

})();
