// Main controller — wires parser, map, playback, and UI together
const App = (() => {

  // ── Constants ────────────────────────────────────────────────────────────────

  const UNITS = {
    BSP: 'kts', TWS: 'kts', AWS: 'kts', SOG: 'kts', VMG: 'kts',
    TWA: '°', AWA: '°', HDG: '°', COG: '°', TWD: '°', Heel: '°', Rudder: '°',
    'Pol0%': '%', 'PolBsp%': '%', 'VMG%': '%',
    PolBsp: 'kts', 'Targ Twa': '°', 'Targ Bsp': 'kts',
    Depth: 'm', Baro: 'hPa', Altitude: 'm',
  };

  const DEFAULT_VAR_NAMES = ['BSP', 'TWS', 'TWA', 'Pol0%'];

  const PORT_COLOR = '#e53935';
  const STBD_COLOR = '#43a047';
  const ABS_TACK_VARS = new Set(['AWA', 'TWA']);

  const RACE_LINES = {
    jog: {
      label: 'JOG',
      a: { lat: 50.770317, lon: -1.313983 },  // Gurnard buoy
      b: { lat: 50.767107, lon: -1.311747 },  // Shore flagpole
    },
    'rorc-west': {
      label: 'RORC West-going',
      a: { lat: 50.786667, lon: -1.309167 },  // Williams Shipping
      b: { lat: 50.766700, lon: -1.300932 },  // Flagpole
    },
    'rorc-east': {
      label: 'RORC East-going',
      a: { lat: 50.782983, lon: -1.295317 },  // South Bramble buoy
      b: { lat: 50.766700, lon: -1.300932 },  // Flagpole (shared with RORC West)
    },
  };

  const RACE_STAT_ROWS = [
    { label: 'Late at start', fn: s => s.lateAtStart   !== null ? fmtDuration(s.lateAtStart)         : '—', warn: () => false },
    { label: 'Finish (UTC)',  fn: s => s.finishTime    !== null ? fmtUTC(s.finishTime)                : '—', warn: () => false },
    { label: 'Elapsed',       fn: s => s.elapsed       !== null ? fmtElapsed(s.elapsed)               : '—', warn: () => false },
    { label: 'IRC corrected', fn: s => s.correctedTime !== null ? fmtElapsed(s.correctedTime)         : '—', warn: () => false },
    { label: 'Dist sailed',   fn: s => s.distanceSailed!== null ? s.distanceSailed.toFixed(1) + ' nm' : '—', warn: s => s.hasBspGap },
    { label: 'GPS distance',  fn: s => s.gpsDistance   !== null ? s.gpsDistance.toFixed(1) + ' nm'   : '—', warn: s => s.hasDataGap },
  ];

  const STATS_ROWS = [
    { key: 'TWS',   label: 'TWS',       unit: 'kts', mode: 'avg'      },
    { key: 'TWD',   label: 'TWD',       unit: '°',   mode: 'circular' },
    { key: 'AWS',   label: 'AWS',       unit: 'kts', mode: 'avg'      },
    { key: 'TWA',   label: '|TWA|',     unit: '°',   mode: 'avgAbs'   },
    { key: 'AWA',      label: '|AWA|',     unit: '°',   mode: 'avgAbs'   },
    { key: 'Targ Twa', label: 'Targ TWA',  unit: '°',   mode: 'avg'      },
    { key: 'Targ Bsp', label: 'Targ BSP',  unit: 'kts', mode: 'avg'      },
    { key: 'BSP',   label: 'BSP',       unit: 'kts', mode: 'avg'      },
    { key: 'PolBsp', label: 'PolBsp',    unit: 'kts', mode: 'avg'      },
    { key: 'PolBsp%', label: 'PolBsp%',  unit: '%',   mode: 'avg', excludeTacks: true },
    { key: 'VMG',   label: 'VMG',       unit: 'kts', mode: 'avg'      },
    { key: 'VMG%',  label: 'VMG%',      unit: '%',   mode: 'avg'      },
  ];

  // ── State ────────────────────────────────────────────────────────────────────

  // name → { boat, fieldTimeseries: Map<fieldId, [{ts,val}]> }
  const boats = new Map();

  // Field names visible in the variable panel
  let displayedVars = [...DEFAULT_VAR_NAMES];

  // All field names seen across all uploaded boats (name → fieldId in first boat that has it)
  const allFieldNames = new Map();

  // Active view: 'map' | 'beating' | 'twd' | 'gybe' | 'graph'
  let currentView = 'map';

  // Variables plotted in the Graph tab
  let graphVars = ['TWS'];

  // Subset of graphVars currently in abs+tack-color mode (AWA/TWA only)
  let absTackVars = new Set();

  // varName → { mode: 'auto' } | { mode: 'manual', min, max }
  const graphScales = new Map();

  // { mode: 'auto' } | { mode: 'manual', start: ms, end: ms }
  let graphXScale = { mode: 'auto' };

  // Smoothing window in seconds (0 = disabled)
  let graphSmooth = 0;

  // Whether track is coloured by tack
  let tackColorMode = false;
  let rulerMode = false;

  // Wind barbs
  let windBarbsVisible = false;
  let windInterval = 10 * 60 * 1000; // 10 minutes in ms

  // Race
  const IRC_DEFAULTS = { bellino: 1.023, griffin: 1.035, mzungu: 1.031 };
  const raceIrcRatings = new Map();  // boatName → user-entered IRC rating

  let raceStartPreset = 'jog';
  let raceFinishPreset = 'jog';
  let raceStartLine  = RACE_LINES.jog;
  let raceFinishLine = RACE_LINES.jog;
  let raceStartTime  = null;  // ms UTC or null (no filter)

  // File queue for sequential name-prompt flow
  let fileQueue = [];

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  let elEmptyOverlay, elVarList, elAddVarSelect, elBoatList,
      elBtnPlay, elBtnRewind, elBtnFF,
      elBtnTrimStart, elBtnTrimEnd, elBtnClearTrim, elBtnTackColor,
      elBtnWind, elWindInterval, elBtnRuler,
      elScrubber, elSpeedSelect, elTimeDisplay,
      elModal, elModalFilename, elBoatNameInput, elBtnModalOk,
      elStatsStart, elStatsEnd, elStatsContent;

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    // Grab DOM refs
    elEmptyOverlay  = document.getElementById('empty-overlay');
    elVarList       = document.getElementById('variable-list');
    elAddVarSelect  = document.getElementById('add-var-select');
    elBoatList      = document.getElementById('boat-list');
    elBtnPlay       = document.getElementById('btn-play');
    elBtnRewind     = document.getElementById('btn-rewind');
    elBtnFF         = document.getElementById('btn-ff');
    elBtnTrimStart  = document.getElementById('btn-trim-start');
    elBtnTrimEnd    = document.getElementById('btn-trim-end');
    elBtnClearTrim  = document.getElementById('btn-clear-trim');
    elScrubber      = document.getElementById('scrubber');
    elSpeedSelect   = document.getElementById('speed-select');
    elTimeDisplay   = document.getElementById('time-display');
    elBtnTackColor  = document.getElementById('btn-tack-color');
    elBtnWind       = document.getElementById('btn-wind');
    elWindInterval  = document.getElementById('wind-interval');
    elBtnRuler      = document.getElementById('btn-ruler');
    elModal         = document.getElementById('name-modal');
    elModalFilename = document.getElementById('modal-filename');
    elBoatNameInput = document.getElementById('boat-name-input');
    elBtnModalOk    = document.getElementById('btn-modal-ok');
    elStatsStart    = document.getElementById('stats-start');
    elStatsEnd      = document.getElementById('stats-end');
    elStatsContent  = document.getElementById('stats-content');

    MapManager.init();
    Analysis.init();
    Graph.init({ onClick: handleGraphLabelClick });

    // View tabs
    document.getElementById('tab-map').addEventListener('click', () => switchView('map'));
    document.getElementById('tab-beating').addEventListener('click', () => switchView('beating'));
    document.getElementById('tab-twd').addEventListener('click', () => switchView('twd'));
    document.getElementById('tab-gybe').addEventListener('click', () => switchView('gybe'));
    document.getElementById('tab-graph').addEventListener('click', () => switchView('graph'));
    document.getElementById('tab-stats').addEventListener('click', () => switchView('stats'));
    document.getElementById('tab-about').addEventListener('click', () => switchView('about'));
    document.getElementById('tab-race').addEventListener('click', () => switchView('race'));
    document.getElementById('btn-stats-apply').addEventListener('click', () => renderStatsTab());

    // Populate speed selector
    Playback.SPEEDS.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s + '×';
      if (s === 1) opt.selected = true;
      elSpeedSelect.appendChild(opt);
    });

    // Init playback callbacks
    Playback.init({
      onTick:            onTick,
      onTrimChange:      onTrimChange,
      onPlayStateChange: onPlayStateChange,
    });

    // Wire controls
    document.getElementById('file-input').addEventListener('change', e => {
      handleFiles(Array.from(e.target.files));
      e.target.value = '';
    });

    const dropZone = document.getElementById('map-container');
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      handleFiles(Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.csv')));
    });

    elBtnPlay.addEventListener('click', () => Playback.toggle());
    elBtnRewind.addEventListener('click', () => Playback.skipToStart());
    elBtnFF.addEventListener('click', () => Playback.skipToEnd());

    elBtnTrimStart.addEventListener('click', () => Playback.setTrimStart());
    elBtnTrimEnd.addEventListener('click',   () => Playback.setTrimEnd());
    elBtnClearTrim.addEventListener('click', () => {
      Playback.clearTrim();
      // MapManager updates happen via the onTrimChange(null, null) callback
    });

    elScrubber.addEventListener('input', () => {
      const st = Playback.getState();
      const ts = st.trimStart + (elScrubber.value / 1000) * (st.trimEnd - st.trimStart);
      Playback.seek(ts);
    });

    elSpeedSelect.addEventListener('change', () => {
      Playback.setSpeed(parseFloat(elSpeedSelect.value));
    });

    elAddVarSelect.addEventListener('change', () => {
      const name = elAddVarSelect.value;
      if (name && !displayedVars.includes(name)) {
        displayedVars.push(name);
        renderVariablePanel();
      }
      elAddVarSelect.value = '';
    });

    // Wind barbs
    elBtnWind.addEventListener('click', () => {
      windBarbsVisible = !windBarbsVisible;
      elBtnWind.classList.toggle('active', windBarbsVisible);
      elWindInterval.classList.toggle('hidden-control', !windBarbsVisible);
      if (windBarbsVisible) refreshWindBarbs();
      else for (const [, entry] of boats) MapManager.hideWindBarbs(entry.boat);
    });
    elWindInterval.addEventListener('change', () => {
      windInterval = parseInt(elWindInterval.value);
      if (windBarbsVisible) refreshWindBarbs();
    });

    // Tack colour toggle
    elBtnTackColor.addEventListener('click', () => {
      tackColorMode = !tackColorMode;
      elBtnTackColor.classList.toggle('active', tackColorMode);
      for (const [, entry] of boats) {
        if (tackColorMode) {
          MapManager.setTackMode(entry.boat, computeTackSegments(entry));
        } else {
          MapManager.clearTackMode(entry.boat);
        }
      }
    });

    elBtnRuler.addEventListener('click', () => {
      rulerMode = !rulerMode;
      elBtnRuler.classList.toggle('active', rulerMode);
      if (rulerMode) MapManager.activateRuler();
      else           MapManager.deactivateRuler();
    });

    // Modal
    elBtnModalOk.addEventListener('click', confirmBoatName);
    elBoatNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBoatName(); });

    renderGraphControls();
    switchView('map');
  }

  // ── File handling ─────────────────────────────────────────────────────────────

  function handleFiles(files) {
    fileQueue.push(...files);
    if (fileQueue.length === files.length) processNextFile();
  }

  function processNextFile() {
    if (fileQueue.length === 0) return;
    const file = fileQueue[0];
    // Default name: filename without extension
    const defaultName = file.name.replace(/\.[^.]+$/, '');
    elModalFilename.textContent = file.name;
    elBoatNameInput.value = defaultName;
    elModal.classList.remove('hidden');
    elBoatNameInput.focus();
    elBoatNameInput.select();
  }

  function confirmBoatName() {
    const name = elBoatNameInput.value.trim() || 'Boat ' + (boats.size + 1);
    elModal.classList.add('hidden');
    const file = fileQueue.shift();
    loadFile(file, name).then(() => {
      if (fileQueue.length > 0) processNextFile();
    });
  }

  async function loadFile(file, name) {
    const text = await file.text();
    const boat = Parser.parse(text, name);
    if (boat.gpsRows.length === 0) {
      alert(`No GPS data found in ${file.name}`);
      return;
    }
    addBoat(boat);
  }

  // ── Boat management ───────────────────────────────────────────────────────────

  function addBoat(boat) {
    // Build per-field time series for carry-forward value lookups
    const fieldTimeseries = buildFieldTimeseries(boat);
    boats.set(boat.name, { boat, fieldTimeseries });

    // Collect all field names
    for (const [id, nm] of Object.entries(boat.fieldMap)) {
      if (!allFieldNames.has(nm)) allFieldNames.set(nm, parseInt(id, 10));
    }

    MapManager.addBoat(boat);
    if (tackColorMode) {
      MapManager.setTackMode(boat, computeTackSegments(boats.get(boat.name)));
    }
    if (currentView === 'beating') Analysis.render(collectUpwindData());
    if (currentView === 'twd')  renderTwdTable();
    if (currentView === 'gybe') renderGybeTable();
    if (currentView === 'graph') Graph.render(collectGraphData());
    if (currentView === 'stats') renderStatsTab();
    updateRaceDisplay();

    recalcPlaybackRange();
    renderGraphControls();
    if (windBarbsVisible) MapManager.showWindBarbs(boat, computeWindBarbs(boats.get(boat.name)));

    // Show the UI
    elEmptyOverlay.classList.add('hidden');

    renderBoatList();
    renderVariablePanel();
    updateAddVarDropdown();

    // Render initial position
    const st = Playback.getState();
    onTick(st.currentTs);
  }

  function rebuildAllFieldNames() {
    allFieldNames.clear();
    for (const [, entry] of boats) {
      for (const [id, nm] of Object.entries(entry.boat.fieldMap)) {
        if (!allFieldNames.has(nm)) allFieldNames.set(nm, parseInt(id, 10));
      }
    }
  }

  function buildFieldTimeseries(boat) {
    // fieldId → [{ts, val}] sorted by ts (rows are already sorted)
    const map = new Map();
    for (const row of boat.rows) {
      for (const [fid, val] of Object.entries(row.fields)) {
        const id = parseInt(fid, 10);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ ts: row.ts, val });
      }
    }
    return map;
  }

  function getFieldValue(entry, fieldName, ts) {
    const fieldId = entry.boat.nameToId[fieldName];
    if (fieldId === undefined) return null;
    const series = entry.fieldTimeseries.get(fieldId);
    if (!series || series.length === 0) return null;
    return carryForward(series, ts);
  }

  function getFieldSeries(entry, fieldName) {
    const fieldId = entry.boat.nameToId[fieldName];
    if (fieldId === undefined) return null;
    return entry.fieldTimeseries.get(fieldId) || null;
  }

  function vmgAt(entry, ts) {
    const bsp = getFieldValue(entry, 'BSP', ts);
    const twa = getFieldValue(entry, 'TWA', ts);
    if (bsp === null || twa === null || bsp < 0) return null;
    return bsp * Math.cos(twa * Math.PI / 180);
  }

  function avgVmgInWindow(entry, fromTs, toTs) {
    const twaSeries = getFieldSeries(entry, 'TWA');
    if (!twaSeries) return null;
    const slice = sliceSeriesByTs(twaSeries, fromTs, toTs);
    if (slice.length === 0) return null;
    let sum = 0, count = 0;
    for (const { ts } of slice) {
      const v = vmgAt(entry, ts);
      if (v !== null) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  function integrateVmg(entry, fromTs, toTs) {
    const twaSeries = getFieldSeries(entry, 'TWA');
    if (!twaSeries) return null;
    const slice = sliceSeriesByTs(twaSeries, fromTs, toTs);
    if (slice.length < 2) return null;
    let integral = 0;
    let prev = null;
    for (const { ts } of slice) {
      const v = vmgAt(entry, ts);
      if (v === null) { prev = null; continue; }
      if (prev !== null) integral += (prev.v + v) / 2 * (ts - prev.ts) / 1000;
      prev = { ts, v };
    }
    return integral; // knot-seconds
  }

  function carryForward(series, ts) {
    if (ts < series[0].ts) return null;
    if (ts >= series[series.length - 1].ts) return series[series.length - 1].val;
    let lo = 0, hi = series.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (series[mid].ts <= ts) lo = mid; else hi = mid;
    }
    return series[lo].val;
  }

  function refreshWindBarbs() {
    for (const [, entry] of boats) {
      MapManager.showWindBarbs(entry.boat, computeWindBarbs(entry));
    }
  }

  function computeWindBarbs(entry) {
    const { boat } = entry;
    const { trimStart, trimEnd } = Playback.getState();
    const barbs = [];
    let nextTs = trimStart;
    for (const r of boat.gpsRows) {
      if (r.ts < trimStart || r.ts > trimEnd) continue;
      if (r.ts < nextTs) continue;
      const twd = getFieldValue(entry, 'TWD', r.ts);
      const tws = getFieldValue(entry, 'TWS', r.ts);
      if (twd !== null && tws !== null) barbs.push({ lat: r.lat, lon: r.lon, twd, tws });
      nextTs = r.ts + windInterval;
    }
    return barbs;
  }

  function recalcPlaybackRange() {
    if (boats.size === 0) {
      elEmptyOverlay.classList.remove('hidden');
      Playback.pause();
      Playback.setRange(0, 0);
      return;
    }
    let minTs = Infinity, maxTs = -Infinity;
    for (const [, entry] of boats) {
      minTs = Math.min(minTs, entry.boat.minTs);
      maxTs = Math.max(maxTs, entry.boat.maxTs);
    }
    Playback.setRange(minTs, maxTs);
  }

  // ── View switching ────────────────────────────────────────────────────────────

  function switchView(view) {
    currentView = view;
    document.getElementById('tab-map').classList.toggle('active', view === 'map');
    document.getElementById('tab-beating').classList.toggle('active', view === 'beating');
    document.getElementById('tab-twd').classList.toggle('active', view === 'twd');
    document.getElementById('tab-gybe').classList.toggle('active', view === 'gybe');
    document.getElementById('tab-graph').classList.toggle('active', view === 'graph');
    document.getElementById('tab-stats').classList.toggle('active', view === 'stats');
    document.getElementById('tab-about').classList.toggle('active', view === 'about');
    document.getElementById('tab-race').classList.toggle('active', view === 'race');
    document.getElementById('map-container').classList.toggle('view-hidden', view !== 'map');
    document.getElementById('analysis-container').classList.toggle('view-hidden', view !== 'beating');
    document.getElementById('twd-container').classList.toggle('view-hidden', view !== 'twd');
    document.getElementById('gybe-container').classList.toggle('view-hidden', view !== 'gybe');
    document.getElementById('graph-container').classList.toggle('view-hidden', view !== 'graph');
    document.getElementById('stats-container').classList.toggle('view-hidden', view !== 'stats');
    document.getElementById('about-container').classList.toggle('view-hidden', view !== 'about');
    document.getElementById('race-container').classList.toggle('view-hidden', view !== 'race');
    document.getElementById('sidebar').classList.toggle('view-hidden', view !== 'map');
    document.getElementById('controls').classList.toggle('view-hidden', view === 'graph' || view === 'stats' || view === 'about' || view === 'race');
    elBtnRuler.classList.toggle('view-hidden', view !== 'map');
    if (view !== 'map' && rulerMode) {
      rulerMode = false;
      elBtnRuler.classList.remove('active');
      MapManager.deactivateRuler();
    }
    if (view !== 'map') MapManager.deactivateLinePlacer();
    if (view === 'map')     MapManager.invalidateSize();
    if (view === 'beating') Analysis.render(collectUpwindData());
    if (view === 'twd')  renderTwdTable();
    if (view === 'gybe') renderGybeTable();
    if (view === 'graph') Graph.render(collectGraphData());
    if (view === 'stats') renderStatsTab();
    if (view === 'race') {
      renderRaceSetup();
      MapManager.setRaceLine('start',  raceStartLine);
      MapManager.setRaceLine('finish', raceFinishLine);
      updateRaceDisplay();
    }
  }

  function collectUpwindData() {
    const { trimStart, trimEnd } = Playback.getState();
    const points = [];
    for (const [, entry] of boats) {
      const twaSeries = getFieldSeries(entry, 'TWA');
      if (!twaSeries) continue;
      for (const { ts, val: twa } of twaSeries) {
        if (ts < trimStart || ts > trimEnd) continue;
        if (Math.abs(twa) >= 55) continue;
        const bsp = getFieldValue(entry, 'BSP', ts);
        if (bsp === null || bsp < 0) continue;
        points.push({ twa, bsp, color: twa < 0 ? PORT_COLOR : STBD_COLOR });
      }
    }
    return points;
  }

  // ── TWD tack analysis ─────────────────────────────────────────────────────────

  function circularMean(degrees) {
    if (degrees.length === 0) return null;
    const sinSum = degrees.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
    const cosSum = degrees.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
    return ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
  }

  function normalizeAngle(d) {
    if (d >  180) return d - 360;
    if (d < -180) return d + 360;
    return d;
  }

  // Binary-search slice of a [{ts,val}] series to a time window — O(log n)
  function sliceSeriesByTs(series, fromTs, toTs) {
    let lo = 0, hi = series.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (series[mid].ts < fromTs) lo = mid + 1; else hi = mid; }
    const start = lo;
    lo = start; hi = series.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (series[mid].ts <= toTs) lo = mid + 1; else hi = mid; }
    return series.slice(start, lo);
  }

  // Returns {mean, range} for TWD in a time window, or null if no data
  function twdWindowStats(entry, fromTs, toTs) {
    const series = getFieldSeries(entry, 'TWD');
    if (!series) return null;
    const slice = sliceSeriesByTs(series, fromTs, toTs);
    if (slice.length === 0) return null;
    const vals = slice.map(p => p.val);
    const mean = circularMean(vals);
    if (slice.length < 2) return { mean, range: 0 };
    const rotated = vals.map(v => normalizeAngle(v - mean));
    return { mean, range: Math.max(...rotated) - Math.min(...rotated) };
  }

  // Tack analysis windows (ms relative to tack timestamp)
  const TACK_PRE_FROM  = -40000, TACK_PRE_TO  = -10000;
  const TACK_POST_FROM =  30000, TACK_POST_TO =  60000;
  const TACK_INT_FROM  = -10000, TACK_INT_TO  =  50000;
  const TACK_INT_S = (TACK_INT_TO - TACK_INT_FROM) / 1000; // integration window in seconds

  function detectTacks(entry) {
    const series = getFieldSeries(entry, 'TWA');
    if (!series || series.length < 2) return [];

    const { trimStart, trimEnd } = Playback.getState();
    const MIN_INTERVAL = 30000; // ms — ignore secondary sign-changes within 30 s
    const tacks = [];
    let lastTackTs = -Infinity;

    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const curr = series[i];
      if (curr.ts < trimStart || prev.ts > trimEnd) continue;
      if (Math.abs(prev.val) >= 90 || Math.abs(curr.val) >= 90) continue;
      if (prev.val * curr.val >= 0) continue; // no sign change

      // Interpolate zero-crossing time
      const frac   = Math.abs(prev.val) / (Math.abs(prev.val) + Math.abs(curr.val));
      const tackTs = prev.ts + frac * (curr.ts - prev.ts);
      if (tackTs - lastTackTs < MIN_INTERVAL) continue;
      const prevTackTs = lastTackTs;
      lastTackTs = tackTs;

      const wasStarboard = prev.val > 0;
      const before = twdWindowStats(entry, tackTs + TACK_PRE_FROM,  tackTs + TACK_PRE_TO);
      const after  = twdWindowStats(entry, tackTs + TACK_POST_FROM, tackTs + TACK_POST_TO);
      if (before === null || after === null) continue;

      const preMean  = avgVmgInWindow(entry, tackTs + TACK_PRE_FROM, tackTs + TACK_PRE_TO);
      const integral = integrateVmg(entry, tackTs + TACK_INT_FROM, tackTs + TACK_INT_TO);
      const groundLost = (preMean !== null && integral !== null)
        ? (preMean * TACK_INT_S - integral) * 0.5144  // knot-s → metres
        : null;

      // Pre-compute VMG profile for chart
      const profile = [];
      const slice = sliceSeriesByTs(series, tackTs + TACK_PRE_FROM, tackTs + TACK_POST_TO);
      for (const { ts } of slice) {
        const v = vmgAt(entry, ts);
        if (v !== null) profile.push({ t: (ts - tackTs) / 1000, vmg: v });
      }

      tacks.push({
        ts:               tackTs,
        portTwd:          wasStarboard ? after.mean  : before.mean,
        stbdTwd:          wasStarboard ? before.mean : after.mean,
        unstable:         before.range > 10 || after.range > 10,
        glUnreliable:     prevTackTs !== -Infinity && (tackTs - prevTackTs < TACK_INT_TO - TACK_PRE_FROM),
        turnedToStarboard: wasStarboard,
        groundLost,
        profile,
      });
    }
    return tacks;
  }

  function renderTackVmgChart(profiles, canvasId, xLabel, emptyMsg, centreLabel) {
    const canvas = document.getElementById(canvasId);
    if (!canvas.offsetWidth) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const BG    = '#0f1923';
    const GRID  = '#1e3248';
    const LABEL = '#7fb3cc';
    const TITLE = '#c8e6f5';
    const M = { top: 24, right: 20, bottom: 44, left: 52 };
    const pW = W - M.left - M.right;
    const pH = H - M.top  - M.bottom;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    if (profiles.length === 0) {
      ctx.fillStyle = LABEL;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(emptyMsg, W / 2, H / 2);
      return;
    }

    const X_MIN = TACK_PRE_FROM / 1000, X_MAX = TACK_POST_TO / 1000;
    const allVmg = profiles.flatMap(p => p.points.map(pt => pt.vmg));
    const yMax = Math.ceil(allVmg.reduce((m, v) => Math.max(m, v), 1) * 1.1);

    const toX = t   => M.left + (t - X_MIN) / (X_MAX - X_MIN) * pW;
    const toY = vmg => M.top  + (1 - vmg / yMax) * pH;

    // Grid lines
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let y = 0; y <= yMax; y++) {
      const py = toY(y);
      ctx.beginPath(); ctx.moveTo(M.left, py); ctx.lineTo(M.left + pW, py); ctx.stroke();
    }
    for (let x = X_MIN; x <= X_MAX; x += 10) {
      const px = toX(x);
      ctx.beginPath(); ctx.moveTo(px, M.top); ctx.lineTo(px, M.top + pH); ctx.stroke();
    }

    // Window boundary markers
    const boundaries = [
      { t: TACK_PRE_FROM / 1000,  label: `${TACK_PRE_FROM / 1000}s`,               dash: [4, 4], color: '#4a7fa5' },
      { t: TACK_INT_FROM / 1000,  label: `${TACK_INT_FROM / 1000}s`,               dash: [4, 4], color: '#4a7fa5' },
      { t: 0,                     label: centreLabel,                               dash: [],     color: '#7fb3cc' },
      { t: TACK_INT_TO   / 1000,  label: `+${TACK_INT_TO   / 1000}s`,              dash: [4, 4], color: '#4a7fa5' },
      { t: TACK_POST_TO  / 1000,  label: `+${TACK_POST_TO  / 1000}s`,              dash: [4, 4], color: '#4a7fa5' },
    ];
    ctx.lineWidth = 1;
    boundaries.forEach(({ t, label, dash, color }) => {
      const px = toX(t);
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(px, M.top); ctx.lineTo(px, M.top + pH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, px, M.top + pH + 14);
    });

    // VMG profiles
    profiles.forEach(({ color, points, baseline }) => {
      // Baseline dashed line
      if (baseline !== null) {
        ctx.setLineDash([6, 3]);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(M.left, toY(baseline));
        ctx.lineTo(M.left + pW, toY(baseline));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Actual VMG line
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const { t, vmg } of points) {
        const px = toX(t), py = toY(vmg);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Axes
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, M.top); ctx.lineTo(M.left, M.top + pH);
    ctx.lineTo(M.left + pW, M.top + pH);
    ctx.stroke();

    // Y tick labels
    ctx.fillStyle = LABEL;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = 0; y <= yMax; y++) {
      ctx.fillText(y, M.left - 6, toY(y));
    }

    // Axis titles
    ctx.fillStyle = TITLE;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(xLabel, M.left + pW / 2, H - 6);
    ctx.save();
    ctx.translate(12, M.top + pH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('VMG (kts)', 0, 0);
    ctx.restore();
  }

  function renderTwdTable() {
    const el = document.getElementById('twd-content');
    if (boats.size === 0) {
      el.innerHTML = '<p class="twd-empty">No log files loaded.</p>';
      renderTackVmgChart([], 'tack-vmg-canvas', 'Time relative to tack (s)', 'No tacks detected — upload a log with upwind sailing', 'Tack');
      return;
    }
    let html = '';
    const allProfiles = [];
    for (const [, entry] of boats) {
      const tacks = detectTacks(entry);
      html += `<div class="twd-boat-section">`;
      html += `<div class="twd-boat-header">
        <span class="boat-dot" style="background:${entry.boat.color}"></span>
        ${entry.boat.name}
      </div>`;
      for (const t of tacks) {
        if (t.profile.length > 1) allProfiles.push({ color: entry.boat.color, points: t.profile, baseline: t.baseline ?? null });
      }

      if (tacks.length === 0) {
        html += `<p class="twd-empty">No tacks detected in the selected range.</p>`;
      } else {
        const showGroundLost = tacks.some(t => t.groundLost !== null);
        // SVG semicircle arrows between 10 o'clock and 2 o'clock positions.
        const ARROW_STBD = `<svg width="20" height="14" viewBox="0 0 20 14" style="vertical-align:middle"><path d="M 3,10 A 8,8 0 0 1 17,10" stroke="${STBD_COLOR}" stroke-width="2" fill="none" stroke-linecap="round"/><polygon points="14,6 10,2.5 10,9.5" fill="${STBD_COLOR}"/></svg>`;
        const ARROW_PORT = `<svg width="20" height="14" viewBox="0 0 20 14" style="vertical-align:middle"><path d="M 3,10 A 8,8 0 0 1 17,10" stroke="${PORT_COLOR}" stroke-width="2" fill="none" stroke-linecap="round"/><polygon points="6,6 10,2.5 10,9.5" fill="${PORT_COLOR}"/></svg>`;
        html += `<table class="twd-table">
          <thead><tr>
            <th>Time (UTC)</th>
            <th></th>
            <th>Port TWD</th>
            <th>Starboard TWD</th>
            <th>Shift</th>
            ${showGroundLost ? '<th>Ground Lost</th>' : ''}
          </tr></thead><tbody>`;
        for (const t of tacks) {
          const d   = new Date(t.ts);
          const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
                        .map(n => String(n).padStart(2, '0')).join(':');
          const shift = normalizeAngle(t.portTwd - t.stbdTwd);
          const shiftStr = (shift >= 0 ? '+' : '') + shift.toFixed(1) + '°';
          const rowStyle = t.unstable ? ' style="color:#ef9a9a"' : '';
          const glStyle = t.glUnreliable ? ' style="color:#ef9a9a"' : '';
          const groundLostCell = showGroundLost
            ? `<td${glStyle}>${t.groundLost !== null ? t.groundLost.toFixed(1) + ' m' : '—'}</td>`
            : '';
          html += `<tr${rowStyle}>
            <td>${hms}</td>
            <td style="text-align:center;padding:5px 8px">${t.turnedToStarboard ? ARROW_STBD : ARROW_PORT}</td>
            <td>${t.portTwd.toFixed(1)}°</td>
            <td>${t.stbdTwd.toFixed(1)}°</td>
            <td>${shiftStr}</td>
            ${groundLostCell}
          </tr>`;
        }
        html += `</tbody></table>`;

        // Summary row
        const shifts = tacks.map(t => normalizeAngle(t.portTwd - t.stbdTwd));
        const avgShift = shifts.reduce((s, v) => s + v, 0) / shifts.length;
        const twaCorrStr = (avgShift / 2 >= 0 ? '+' : '') + (avgShift / 2).toFixed(1) + '°';
        const glValues = tacks.filter(t => t.groundLost !== null).map(t => t.groundLost);
        const avgGl = glValues.length > 0 ? (glValues.reduce((s, v) => s + v, 0) / glValues.length).toFixed(1) + ' m' : null;
        const { trimStart, trimEnd } = Playback.getState();
        const twsSeries = getFieldSeries(entry, 'TWS');
        const twsSlice = twsSeries ? sliceSeriesByTs(twsSeries, trimStart, trimEnd) : [];
        const avgTws = twsSlice.length > 0
          ? (twsSlice.reduce((s, p) => s + p.val, 0) / twsSlice.length).toFixed(1) + ' kts'
          : null;
        html += `<div class="twd-summary">
          <span>${tacks.length} tack${tacks.length !== 1 ? 's' : ''}</span>
          <span class="twd-summary-sep">·</span>
          <span>TWA correction: <strong>${twaCorrStr}</strong></span>
          ${avgGl !== null ? `<span class="twd-summary-sep">·</span><span>Avg ground lost: <strong>${avgGl}</strong></span>` : ''}
          ${avgTws !== null ? `<span class="twd-summary-sep">·</span><span>Avg TWS: <strong>${avgTws}</strong></span>` : ''}
        </div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
    renderTackVmgChart(allProfiles,
      'tack-vmg-canvas',
      'Time relative to tack (s)',
      'No tacks detected — upload a log with upwind sailing',
      'Tack');
  }

  function computeTackSegments(entry) {
    const { boat } = entry;
    const segments = [];
    let segColor  = null;
    let segLatlngs = [];

    for (const r of boat.gpsRows) {
      const twa = getFieldValue(entry, 'TWA', r.ts);
      const color = twa === null ? boat.color
                  : twa < 0    ? PORT_COLOR
                  :              STBD_COLOR;

      if (segColor === null) segColor = color;

      if (color !== segColor) {
        // Tack change: close current segment including this point for continuity
        segLatlngs.push([r.lat, r.lon]);
        segments.push({ latlngs: segLatlngs, color: segColor });
        segLatlngs = [[r.lat, r.lon]];
        segColor   = color;
      } else {
        segLatlngs.push([r.lat, r.lon]);
      }
    }
    if (segLatlngs.length > 0) segments.push({ latlngs: segLatlngs, color: segColor });
    return segments;
  }

  // ── Gybe analysis ────────────────────────────────────────────────────────────

  function detectGybes(entry) {
    const series = getFieldSeries(entry, 'TWA');
    if (!series || series.length < 2) return [];

    const { trimStart, trimEnd } = Playback.getState();
    const MIN_INTERVAL = 30000;
    const gybes = [];
    let lastGybeTs = -Infinity;

    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const curr = series[i];
      if (curr.ts < trimStart || prev.ts > trimEnd) continue;
      if (Math.abs(prev.val) < 90 || Math.abs(curr.val) < 90) continue;
      if (prev.val * curr.val >= 0) continue;

      const frac   = (180 - Math.abs(prev.val)) / ((180 - Math.abs(prev.val)) + (180 - Math.abs(curr.val)));
      const gybeTs = prev.ts + frac * (curr.ts - prev.ts);
      if (gybeTs - lastGybeTs < MIN_INTERVAL) continue;
      const prevGybeTs = lastGybeTs;
      lastGybeTs = gybeTs;

      // prev.val > 0 = was on starboard gybe → gybe turns to port; < 0 → turns to starboard
      const wasOnStarboard    = prev.val > 0;
      const turnedToStarboard = !wasOnStarboard;

      const before = twdWindowStats(entry, gybeTs + TACK_PRE_FROM,  gybeTs + TACK_PRE_TO);
      const after  = twdWindowStats(entry, gybeTs + TACK_POST_FROM, gybeTs + TACK_POST_TO);
      if (before === null || after === null) continue;

      const preMean  = avgVmgInWindow(entry, gybeTs + TACK_PRE_FROM, gybeTs + TACK_PRE_TO);
      const integral = integrateVmg(entry, gybeTs + TACK_INT_FROM, gybeTs + TACK_INT_TO);
      // Downwind VMG is negative; negate formula so positive = ground lost downwind
      const groundLost = (preMean !== null && integral !== null)
        ? (integral - preMean * TACK_INT_S) * 0.5144
        : null;

      const profile = [];
      const slice = sliceSeriesByTs(series, gybeTs + TACK_PRE_FROM, gybeTs + TACK_POST_TO);
      for (const { ts } of slice) {
        const v = vmgAt(entry, ts);
        if (v !== null) profile.push({ t: (ts - gybeTs) / 1000, vmg: -v }); // negate: downwind VMG is negative, chart shows positive progress
      }

      gybes.push({
        ts:               gybeTs,
        portTwd:          wasOnStarboard ? after.mean  : before.mean,
        stbdTwd:          wasOnStarboard ? before.mean : after.mean,
        unstable:         before.range > 10 || after.range > 10,
        glUnreliable:     prevGybeTs !== -Infinity && (gybeTs - prevGybeTs < TACK_INT_TO - TACK_PRE_FROM),
        turnedToStarboard,
        groundLost,
        profile,
      });
    }
    return gybes;
  }

  function renderGybeTable() {
    const el = document.getElementById('gybe-content');
    if (boats.size === 0) {
      el.innerHTML = '<p class="twd-empty">No log files loaded.</p>';
      renderTackVmgChart([], 'gybe-vmg-canvas', 'Time relative to gybe (s)', 'No gybes detected — upload a log with downwind sailing', 'Gybe');
      return;
    }
    let html = '';
    const allProfiles = [];
    for (const [, entry] of boats) {
      const gybes = detectGybes(entry);
      html += `<div class="twd-boat-section">`;
      html += `<div class="twd-boat-header">
        <span class="boat-dot" style="background:${entry.boat.color}"></span>
        ${entry.boat.name}
      </div>`;
      for (const g of gybes) {
        if (g.profile.length > 1) allProfiles.push({ color: entry.boat.color, points: g.profile, baseline: null });
      }

      if (gybes.length === 0) {
        html += `<p class="twd-empty">No gybes detected in the selected range.</p>`;
      } else {
        const showGroundLost = gybes.some(g => g.groundLost !== null);
        // Bottom-arc arrows
        const ARROW_STBD = `<svg width="20" height="14" viewBox="0 0 20 14" style="vertical-align:middle"><path d="M 3,4 A 8,8 0 0 0 17,4" stroke="${STBD_COLOR}" stroke-width="2" fill="none" stroke-linecap="round"/><polygon points="13.5,12 10,9.5 10,14.5" fill="${STBD_COLOR}"/></svg>`;
        const ARROW_PORT = `<svg width="20" height="14" viewBox="0 0 20 14" style="vertical-align:middle"><path d="M 3,4 A 8,8 0 0 0 17,4" stroke="${PORT_COLOR}" stroke-width="2" fill="none" stroke-linecap="round"/><polygon points="6.5,12 10,9.5 10,14.5" fill="${PORT_COLOR}"/></svg>`;
        html += `<table class="twd-table">
          <thead><tr>
            <th>Time (UTC)</th>
            <th></th>
            <th>Port TWD</th>
            <th>Starboard TWD</th>
            <th>Shift</th>
            ${showGroundLost ? '<th>Ground Lost</th>' : ''}
          </tr></thead><tbody>`;
        for (const g of gybes) {
          const d   = new Date(g.ts);
          const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
                        .map(n => String(n).padStart(2, '0')).join(':');
          const shift = normalizeAngle(g.portTwd - g.stbdTwd);
          const shiftStr = (shift >= 0 ? '+' : '') + shift.toFixed(1) + '°';
          const rowStyle = g.unstable ? ' style="color:#ef9a9a"' : '';
          const glStyle = g.glUnreliable ? ' style="color:#ef9a9a"' : '';
          const groundLostCell = showGroundLost
            ? `<td${glStyle}>${g.groundLost !== null ? g.groundLost.toFixed(1) + ' m' : '—'}</td>`
            : '';
          html += `<tr${rowStyle}>
            <td>${hms}</td>
            <td style="text-align:center;padding:5px 8px">${g.turnedToStarboard ? ARROW_STBD : ARROW_PORT}</td>
            <td>${g.portTwd.toFixed(1)}°</td>
            <td>${g.stbdTwd.toFixed(1)}°</td>
            <td>${shiftStr}</td>
            ${groundLostCell}
          </tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
    renderTackVmgChart(allProfiles,
      'gybe-vmg-canvas',
      'Time relative to gybe (s)',
      'No gybes detected — upload a log with downwind sailing',
      'Gybe');
  }

  // ── Statistics tab ────────────────────────────────────────────────────────────

  function computeSE(sumSq, n) {
    return n > 1 ? Math.sqrt(sumSq / n / n) : 0;
  }

  function getStatValue(entry, row, startTs, endTs, tacks) {
    if (row.mode === 'avg' || row.mode === 'avgAbs') {
      const series = getFieldSeries(entry, row.key);
      if (!series) return null;
      let slice = sliceSeriesByTs(series, startTs, endTs);
      if (slice.length === 0) return null;
      if ((row.mode === 'avgAbs' || row.excludeTacks) && tacks && tacks.length > 0) {
        slice = slice.filter(p => !tacks.some(
          t => p.ts >= t.ts + TACK_INT_FROM && p.ts <= t.ts + TACK_INT_TO
        ));
        if (slice.length === 0) return null;
      }
      const vals = slice.map(p => row.mode === 'avgAbs' ? Math.abs(p.val) : p.val);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const se   = computeSE(vals.reduce((s, v) => s + (v - mean) ** 2, 0), vals.length);
      return { mean, se };
    }
    if (row.mode === 'circular') {
      const series = getFieldSeries(entry, row.key);
      if (!series) return null;
      const slice = sliceSeriesByTs(series, startTs, endTs);
      if (slice.length === 0) return null;
      const vals = slice.map(p => p.val);
      const mean = circularMean(vals);
      if (mean === null) return null;
      const se = computeSE(vals.reduce((s, v) => s + normalizeAngle(v - mean) ** 2, 0), vals.length);
      return { mean, se };
    }
    return null;
  }

  function haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function getIrcRating(boatName) {
    if (raceIrcRatings.has(boatName)) return raceIrcRatings.get(boatName);
    const lower = boatName.toLowerCase();
    for (const [key, val] of Object.entries(IRC_DEFAULTS)) {
      if (lower.includes(key)) return val;
    }
    return null;
  }

  function computeBoatRaceStats(entry, boatResult) {
    const firstStart  = boatResult.startCrossings[0]  ?? null;
    const firstFinish = boatResult.finishCrossings[0] ?? null;

    const lateAtStart = (firstStart && raceStartTime !== null) ? firstStart.ts - raceStartTime : null;
    const finishTime  = firstFinish ? firstFinish.ts : null;
    const elapsed     = (finishTime !== null && raceStartTime !== null) ? finishTime - raceStartTime : null;
    const irc         = getIrcRating(entry.boat.name);
    const correctedTime = (elapsed !== null && irc !== null) ? elapsed * irc : null;

    let distanceSailed = null;
    let hasBspGap = false;
    if (firstStart && firstFinish) {
      const bspSeries = getFieldSeries(entry, 'BSP');
      if (bspSeries) {
        const slice = sliceSeriesByTs(bspSeries, firstStart.ts, firstFinish.ts);
        if (slice.length >= 2) {
          if (slice[0].ts - firstStart.ts > 60000) hasBspGap = true;
          if (firstFinish.ts - slice[slice.length - 1].ts > 60000) hasBspGap = true;
          let dist = 0;
          for (let i = 1; i < slice.length; i++) {
            const dtHrs = (slice[i].ts - slice[i-1].ts) / 3600000;
            if (slice[i].ts - slice[i-1].ts > 60000) hasBspGap = true;
            dist += ((slice[i].val + slice[i-1].val) / 2) * dtHrs;
          }
          distanceSailed = Math.max(0, dist);
        } else {
          hasBspGap = true;
        }
      }
    }

    let gpsDistance = null;
    let hasDataGap = false;
    if (firstStart && firstFinish) {
      const rows = entry.boat.gpsRows.filter(r => r.ts >= firstStart.ts && r.ts <= firstFinish.ts);
      if (rows.length >= 2) {
        // Check gap between start crossing and first GPS row (crossing may have been
        // interpolated across a gap, so the pre-gap row was excluded by the filter)
        if (rows[0].ts - firstStart.ts > 60000) hasDataGap = true;
        // Check gap between last GPS row and finish crossing (same boundary issue)
        if (firstFinish.ts - rows[rows.length - 1].ts > 60000) hasDataGap = true;
        let dist = 0;
        for (let i = 1; i < rows.length; i++) {
          const gap = rows[i].ts - rows[i-1].ts;
          if (gap > 60000) hasDataGap = true;
          dist += haversineNm(rows[i-1].lat, rows[i-1].lon, rows[i].lat, rows[i].lon);
        }
        gpsDistance = dist;
      } else {
        hasDataGap = true;
      }
    }

    return { lateAtStart, finishTime, elapsed, correctedTime, distanceSailed, gpsDistance, hasBspGap, hasDataGap };
  }

  function renderRaceStatsSection(boatEntries) {
    const raceResults = computeRaceResults();
    const statsByBoat = boatEntries.map(entry => {
      const boatResult = raceResults.find(r => r.name === entry.boat.name);
      return boatResult ? computeBoatRaceStats(entry, boatResult) : null;
    });

    let ircHtml = boatEntries.map(({ boat }) => {
      const rating = raceIrcRatings.has(boat.name)
        ? raceIrcRatings.get(boat.name)
        : (getIrcRating(boat.name) ?? '');
      return `<label class="irc-rating-label">
        <span class="boat-dot" style="background:${boat.color}"></span>
        ${boat.name}
        <input class="irc-input" type="number" data-name="${boat.name}"
          value="${rating}" step="0.001" min="0.5" max="2.0" placeholder="IRC">
      </label>`;
    }).join('');

    let html = `<div class="race-stats-block">
      <div class="race-stats-header">
        <span class="race-stats-title">Race Statistics</span>
      </div>
      <div class="irc-ratings-row"><span class="stats-section-label">IRC Rating</span>${ircHtml}</div>
      <table class="stats-table"><thead><tr>
        <th>Stat</th><th></th>`;
    for (const { boat } of boatEntries) {
      html += `<th><span class="boat-dot" style="background:${boat.color};margin-right:5px"></span>${boat.name}</th>`;
    }
    html += `</tr></thead><tbody>`;
    for (const { label, fn, warn } of RACE_STAT_ROWS) {
      html += `<tr><td class="stats-var">${label}</td><td class="stats-unit"></td>`;
      statsByBoat.forEach(s => {
        const cls = (s && warn(s)) ? ' class="stats-warn"' : '';
        html += `<td${cls}>${s ? fn(s) : '—'}</td>`;
      });
      html += `</tr>`;
    }
    html += `</tbody></table></div><div class="stats-section-divider"></div>`;
    return html;
  }

  function renderStatsTab() {
    const { trimStart, trimEnd } = Playback.getState();
    if (!elStatsStart.value) elStatsStart.value = fmtUTC(trimStart);
    if (!elStatsEnd.value)   elStatsEnd.value   = fmtUTC(trimEnd);

    const startTs = parseUTCTime(elStatsStart.value, trimStart) ?? trimStart;
    const endTs   = parseUTCTime(elStatsEnd.value,   trimStart) ?? trimEnd;

    if (boats.size === 0) {
      elStatsContent.innerHTML = '<p class="twd-empty">No log files loaded.</p>';
      return;
    }

    const boatEntries = [...boats.values()];
    const boatTacks   = boatEntries.map(entry => detectTacks(entry));

    let html = '';
    if (raceStartLine || raceFinishLine) html += renderRaceStatsSection(boatEntries);

    html += '<div class="race-stats-header"><span class="race-stats-title">Data for the selected time period</span></div><table class="stats-table"><thead><tr><th>Variable</th><th>Unit</th>';
    for (const { boat } of boatEntries) {
      html += `<th><span class="boat-dot" style="background:${boat.color};margin-right:5px"></span>${boat.name}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const row of STATS_ROWS) {
      html += `<tr><td class="stats-var">${row.label}</td><td class="stats-unit">${row.unit}</td>`;
      boatEntries.forEach((entry, i) => {
        const val = getStatValue(entry, row, startTs, endTs, boatTacks[i]);
        html += `<td>${formatStat(val, row.unit)}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table>';
    elStatsContent.innerHTML = html;

    elStatsContent.querySelectorAll('.irc-input').forEach(input => {
      input.addEventListener('change', () => {
        const val = parseFloat(input.value);
        if (!isNaN(val) && val > 0) raceIrcRatings.set(input.dataset.name, val);
        else raceIrcRatings.delete(input.dataset.name);
        renderStatsTab();
      });
    });
  }

  function formatStat(stat, unit) {
    if (stat === null) return '—';
    const dp = unit === 'kts' ? 2 : 1;
    return `${stat.mean.toFixed(dp)} <span class="stats-se">(±${stat.se.toFixed(dp)})</span>`;
  }

  // ── Graph tab ─────────────────────────────────────────────────────────────────

  function fmtUTC(ms) {
    const d = new Date(ms);
    return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
  }

  function parseUTCTime(str, refMs) {
    const m = str.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date(refMs);
    d.setUTCHours(+m[1], +m[2], m[3] !== undefined ? +m[3] : 0, 0);
    return d.getTime();
  }

  function handleGraphLabelClick(varName, clientX, clientY) {
    const existing = document.getElementById('graph-scale-popup');
    if (existing) existing.remove();

    const isXAxis = varName === null;
    const current = isXAxis ? graphXScale : (graphScales.get(varName) || { mode: 'auto' });

    const popup = document.createElement('div');
    popup.id = 'graph-scale-popup';
    popup.className = 'graph-scale-popup';
    popup.style.left = clientX + 8 + 'px';
    popup.style.top  = clientY - 16 + 'px';

    let outsideClick;
    const dismiss = () => {
      popup.remove();
      document.removeEventListener('mousedown', outsideClick);
    };

    const autoBtn = document.createElement('button');
    autoBtn.textContent = 'Auto';
    autoBtn.className = current.mode === 'auto' ? 'active' : '';
    autoBtn.addEventListener('click', () => {
      if (isXAxis) graphXScale = { mode: 'auto' };
      else graphScales.delete(varName);
      dismiss();
      if (currentView === 'graph') Graph.render(collectGraphData());
    });

    const manualBtn = document.createElement('button');
    manualBtn.textContent = 'Manual';
    manualBtn.className = current.mode === 'manual' ? 'active' : '';
    manualBtn.addEventListener('click', () => {
      dismiss();
      if (isXAxis) {
        const { trimStart, trimEnd } = Playback.getState();
        const defStart = current.mode === 'manual' ? fmtUTC(current.start) : fmtUTC(trimStart);
        const defEnd   = current.mode === 'manual' ? fmtUTC(current.end)   : fmtUTC(trimEnd);
        const startStr = window.prompt('Start time (HH:MM or HH:MM:SS UTC):', defStart);
        if (startStr === null) return;
        const endStr = window.prompt('End time (HH:MM or HH:MM:SS UTC):', defEnd);
        if (endStr === null) return;
        const start = parseUTCTime(startStr, trimStart);
        const end   = parseUTCTime(endStr,   trimStart);
        if (start === null || end === null || start >= end) {
          alert('Invalid times — enter HH:MM or HH:MM:SS where start < end.');
          return;
        }
        graphXScale = { mode: 'manual', start, end };
      } else {
        const defMin = current.mode === 'manual' ? current.min : '';
        const defMax = current.mode === 'manual' ? current.max : '';
        const minStr = window.prompt(`${varName} — lower limit:`, defMin);
        if (minStr === null) return;
        const maxStr = window.prompt(`${varName} — upper limit:`, defMax);
        if (maxStr === null) return;
        const min = parseFloat(minStr);
        const max = parseFloat(maxStr);
        if (isNaN(min) || isNaN(max) || min >= max) {
          alert('Invalid limits — enter two numbers where lower < upper.');
          return;
        }
        graphScales.set(varName, { mode: 'manual', min, max });
      }
      if (currentView === 'graph') Graph.render(collectGraphData());
    });

    popup.appendChild(autoBtn);
    popup.appendChild(manualBtn);
    document.body.appendChild(popup);

    // Clamp popup into viewport after it's in the DOM and has a measured size
    const pr = popup.getBoundingClientRect();
    if (pr.bottom > window.innerHeight) popup.style.top  = (clientY - pr.height - 8) + 'px';
    if (pr.right  > window.innerWidth)  popup.style.left = (clientX - pr.width  - 8) + 'px';

    outsideClick = e => { if (!popup.contains(e.target)) dismiss(); };
    setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
  }

  function smoothSeries(pts, windowMs) {
    if (!windowMs || pts.length < 2) return pts;
    const sigma2 = 2 * (windowMs / 6) * (windowMs / 6);
    const n = pts.length;
    const result = new Array(n);
    // Two-pointer sliding window — pts is sorted by ts, so lo/hi only advance
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      const t = pts[i].ts;
      while (pts[lo].ts < t - windowMs) lo++;
      while (hi < n && pts[hi].ts <= t + windowMs) hi++;
      let wSum = 0, vSum = 0;
      for (let j = lo; j < hi; j++) {
        const dt = pts[j].ts - t;
        const w = Math.exp(-(dt * dt) / sigma2);
        wSum += w;
        vSum += w * pts[j].val;
      }
      result[i] = { ts: t, val: wSum > 0 ? vSum / wSum : pts[i].val };
    }
    return result;
  }

  function collectGraphData() {
    const { trimStart, trimEnd, currentTs } = Playback.getState();
    let xStart = trimStart, xEnd = trimEnd;
    if (graphXScale.mode === 'manual') {
      xStart = Math.max(graphXScale.start, trimStart);
      xEnd   = Math.min(graphXScale.end,   trimEnd);
      if (xStart >= xEnd) { xStart = trimStart; xEnd = trimEnd; }
    }
    return {
      trimStart, trimEnd, currentTs,
      xStart, xEnd, xScale: graphXScale,
      series: graphVars.map(varName => {
        const isAbsTack = absTackVars.has(varName);
        return {
          varName,
          unit: UNITS[varName] || '',
          absTack: isAbsTack,
          scale: graphScales.get(varName) || { mode: 'auto' },
          boats: [...boats.values()]
            .map(entry => {
              const raw = sliceSeriesByTs(getFieldSeries(entry, varName) || [], xStart, xEnd);
              const pts = graphSmooth > 0 ? smoothSeries(raw, graphSmooth * 1000) : raw;
              const absTackPoints = isAbsTack
                ? pts.map(p => ({ ts: p.ts, val: Math.abs(p.val), _sign: Math.sign(p.val) }))
                : null;
              const sourcePts = isAbsTack ? absTackPoints : pts;
              const avg = sourcePts.length > 0
                ? sourcePts.reduce((s, p) => s + p.val, 0) / sourcePts.length
                : null;
              return { name: entry.boat.name, color: entry.boat.color, points: pts, absTackPoints, avg };
            })
            .filter(b => b.points.length > 0),
        };
      }),
    };
  }

  function renderGraphControls() {
    const el = document.getElementById('graph-controls');
    el.innerHTML = '';

    // Variable chips
    for (const varName of graphVars) {
      const chip = document.createElement('span');
      chip.className = 'graph-var-chip';

      const label = document.createElement('span');
      label.textContent = varName;
      chip.appendChild(label);

      if (ABS_TACK_VARS.has(varName)) {
        const absBtn = document.createElement('button');
        absBtn.className = 'graph-abs-btn' + (absTackVars.has(varName) ? ' active' : '');
        absBtn.title = 'Toggle abs + tack color';
        absBtn.textContent = '|±|';
        absBtn.addEventListener('click', () => {
          if (absTackVars.has(varName)) absTackVars.delete(varName);
          else absTackVars.add(varName);
          renderGraphControls();
          if (currentView === 'graph') Graph.render(collectGraphData());
        });
        chip.appendChild(absBtn);
      }

      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.title = 'Remove';
      btn.addEventListener('click', () => {
        graphVars = graphVars.filter(v => v !== varName);
        absTackVars.delete(varName);
        graphScales.delete(varName);
        renderGraphControls();
        if (currentView === 'graph') Graph.render(collectGraphData());
      });

      chip.appendChild(btn);
      el.appendChild(chip);
    }

    // Add variable dropdown
    const sel = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '+ Add variable';
    sel.appendChild(placeholder);
    const sorted = [...allFieldNames.keys()].sort();
    for (const name of sorted) {
      if (!graphVars.includes(name)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
    }
    sel.addEventListener('change', () => {
      const name = sel.value;
      if (name && !graphVars.includes(name)) {
        graphVars.push(name);
        renderGraphControls();
        if (currentView === 'graph') Graph.render(collectGraphData());
      }
    });
    el.appendChild(sel);

    // Smooth button
    const smoothBtn = document.createElement('button');
    smoothBtn.id = 'btn-graph-smooth';
    smoothBtn.className = graphSmooth > 0 ? 'active' : '';
    smoothBtn.title = 'Smooth data with a Gaussian moving average';
    smoothBtn.textContent = graphSmooth > 0 ? `~${graphSmooth}s` : 'Smooth';
    smoothBtn.addEventListener('click', () => {
      const input = window.prompt('Smooth window in seconds (0 to disable):', graphSmooth > 0 ? String(graphSmooth) : '30');
      if (input === null) return;
      const secs = parseFloat(input);
      graphSmooth = isNaN(secs) || secs <= 0 ? 0 : secs;
      smoothBtn.classList.toggle('active', graphSmooth > 0);
      smoothBtn.textContent = graphSmooth > 0 ? `~${graphSmooth}s` : 'Smooth';
      if (currentView === 'graph') Graph.render(collectGraphData());
    });
    el.appendChild(smoothBtn);
  }

  // ── Playback callbacks ────────────────────────────────────────────────────────

  function onTick(ts) {
    for (const [, entry] of boats) {
      const hdg = getFieldValue(entry, 'HDG', ts) ?? getFieldValue(entry, 'COG', ts) ?? 0;
      MapManager.updateMarker(entry.boat, ts, hdg);
    }
    updateVariableValues(ts);
    updateScrubber(ts);
    updateTimeDisplay(ts);
    if (currentView === 'graph') Graph.updateCursor(ts);
  }

  function onTrimChange(start, end) {
    for (const [, entry] of boats) {
      if (start === null) MapManager.clearTrim(entry.boat);
      else MapManager.setTrim(entry.boat, start, end);
    }
    updateScrubberRange();
    if (currentView === 'beating') Analysis.render(collectUpwindData());
    if (currentView === 'twd')  renderTwdTable();
    if (currentView === 'gybe') renderGybeTable();
    if (currentView === 'graph') Graph.render(collectGraphData());
    if (windBarbsVisible) refreshWindBarbs();
  }

  function onPlayStateChange(playing) {
    elBtnPlay.textContent = playing ? '⏸' : '▶';
    elBtnPlay.title = playing ? 'Pause' : 'Play';
  }

  // ── UI rendering ──────────────────────────────────────────────────────────────

  function renderBoatList() {
    elBoatList.innerHTML = '';
    for (const [, entry] of boats) {
      const div = document.createElement('div');
      div.className = 'boat-item';

      const dot = document.createElement('span');
      dot.className = 'boat-dot';
      dot.style.background = entry.boat.color;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'boat-name';
      nameSpan.textContent = entry.boat.name;

      const btn = document.createElement('button');
      btn.className = 'btn-remove-boat';
      btn.title = 'Remove';
      btn.textContent = '×';
      btn.dataset.name = entry.boat.name;
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        MapManager.removeBoat(name);
        boats.delete(name);
        rebuildAllFieldNames();
        recalcPlaybackRange();
        for (const [, e] of boats) MapManager.clearTrim(e.boat);
        const st = Playback.getState();
        onTick(st.currentTs);
        if (currentView === 'beating') Analysis.render(collectUpwindData());
        if (currentView === 'twd')  renderTwdTable();
        if (currentView === 'gybe') renderGybeTable();
        if (currentView === 'graph') Graph.render(collectGraphData());
        if (currentView === 'stats') renderStatsTab();
        updateRaceDisplay();
        renderBoatList();
        renderVariablePanel();
        updateAddVarDropdown();
        renderGraphControls();
      });

      div.appendChild(dot);
      div.appendChild(nameSpan);
      div.appendChild(btn);
      elBoatList.appendChild(div);
    }
  }

  function renderVariablePanel() {
    elVarList.innerHTML = '';
    const st = Playback.getState();

    for (const varName of displayedVars) {
      const row = document.createElement('div');
      row.className = 'var-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.addEventListener('change', () => {
        if (!checkbox.checked) {
          displayedVars = displayedVars.filter(v => v !== varName);
          renderVariablePanel();
          updateAddVarDropdown();
        }
      });

      const label = document.createElement('span');
      label.className = 'var-name';
      label.textContent = varName;

      const values = document.createElement('span');
      values.className = 'var-values';

      for (const [boatName, entry] of boats) {
        const dot = document.createElement('span');
        dot.className = 'var-dot';
        dot.style.background = entry.boat.color;

        const num = document.createElement('span');
        num.className = 'var-num';
        num.id = `varnum-${cssId(varName)}-${cssId(boatName)}`;
        num.textContent = formatVarValue(getFieldValue(entry, varName, st.currentTs), varName);

        values.appendChild(dot);
        values.appendChild(num);
      }

      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(values);
      elVarList.appendChild(row);
    }
  }

  function updateVariableValues(ts) {
    for (const varName of displayedVars) {
      for (const [boatName, entry] of boats) {
        const el = document.getElementById(`varnum-${cssId(varName)}-${cssId(boatName)}`);
        if (!el) continue;
        el.textContent = formatVarValue(getFieldValue(entry, varName, ts), varName);
      }
    }
  }

  function updateAddVarDropdown() {
    // Show all known field names that aren't already displayed
    elAddVarSelect.innerHTML = '<option value="">+ Add variable</option>';
    const sorted = [...allFieldNames.keys()].sort();
    for (const name of sorted) {
      if (!displayedVars.includes(name)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        elAddVarSelect.appendChild(opt);
      }
    }
  }

  function updateScrubber(ts) {
    const st = Playback.getState();
    const range = st.trimEnd - st.trimStart;
    const pos = range > 0 ? ((ts - st.trimStart) / range) * 1000 : 0;
    elScrubber.value = Math.max(0, Math.min(1000, pos));
  }

  function updateScrubberRange() {
    // Scrubber is always 0–1000; mapping is done in seek handler
    // Just re-render current position
    const st = Playback.getState();
    updateScrubber(st.currentTs);
  }

  function updateTimeDisplay(ts) {
    const d = new Date(ts);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    elTimeDisplay.textContent = `${hh}:${mm}:${ss} UTC`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function formatVarValue(v, fieldName) {
    if (v === null) return '—';
    const unit = UNITS[fieldName] || '';
    const num = (unit === '°' || unit === '%') ? v.toFixed(0) : v.toFixed(1);
    return unit ? num + '\u00a0' + unit : num;
  }

  function cssId(name) {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  // ── Race tab ──────────────────────────────────────────────────────────────────

  function lineCrossing(p1, p2, lineA, lineB) {
    const dx1 = p2.lon - p1.lon, dy1 = p2.lat - p1.lat;
    const dx2 = lineB.lon - lineA.lon, dy2 = lineB.lat - lineA.lat;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-12) return null;
    const ox = lineA.lon - p1.lon, oy = lineA.lat - p1.lat;
    const t = (ox * dy2 - oy * dx2) / denom;
    const u = (ox * dy1 - oy * dx1) / denom;
    return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : null;
  }

  function computeRaceResults() {
    const results = [];
    for (const [, entry] of boats) {
      const rows = entry.boat.gpsRows;
      const startCrossings = [], finishCrossings = [];
      for (let i = 1; i < rows.length; i++) {
        const p1 = rows[i - 1], p2 = rows[i];
        if (raceStartLine) {
          const t = lineCrossing(p1, p2, raceStartLine.a, raceStartLine.b);
          if (t !== null) {
            const ts = p1.ts + t * (p2.ts - p1.ts);
            if (!raceStartTime || ts >= raceStartTime) {
              startCrossings.push({
                ts,
                lat: p1.lat + t * (p2.lat - p1.lat),
                lon: p1.lon + t * (p2.lon - p1.lon),
              });
            }
          }
        }
        if (raceFinishLine) {
          const t = lineCrossing(p1, p2, raceFinishLine.a, raceFinishLine.b);
          if (t !== null) {
            const ts = p1.ts + t * (p2.ts - p1.ts);
            finishCrossings.push({
              ts,
              lat: p1.lat + t * (p2.lat - p1.lat),
              lon: p1.lon + t * (p2.lon - p1.lon),
            });
          }
        }
      }
      results.push({ name: entry.boat.name, color: entry.boat.color, startCrossings, finishCrossings });
    }
    return results;
  }

  function fmtDuration(ms) {
    const totalS = Math.round(ms / 1000);
    const sign   = totalS < 0 ? '-' : '+';
    const abs    = Math.abs(totalS);
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${sign}${h}:${mm}:${ss}` : `${sign}${m}:${ss}`;
  }

  function fmtElapsed(ms) {
    const totalS = Math.round(Math.abs(ms / 1000));
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function renderRaceSetup() {
    const el = document.getElementById('race-setup');
    if (!el) return;

    let dateStr = '';
    if (boats.size > 0) {
      const d = new Date(boats.values().next().value.boat.minTs);
      dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }

    const presetKeys = [...Object.keys(RACE_LINES), 'custom'];
    const presetLabel = k => k === 'custom' ? 'Custom' : RACE_LINES[k].label;
    const startTimeVal = raceStartTime ? fmtUTC(raceStartTime) : '';

    const radioRow = (name, current) => presetKeys.map(k =>
      `<label><input type="radio" name="${name}" value="${k}"${current === k ? ' checked' : ''}> ${presetLabel(k)}</label>`
    ).join('');

    el.innerHTML = `
      <div class="race-section">
        <h3>Start Line</h3>
        <div class="race-radio-group">${radioRow('race-start', raceStartPreset)}</div>
        <button id="btn-place-start"${raceStartPreset !== 'custom' ? ' class="hidden-control"' : ''}>Place on map ↗</button>
        <div class="race-start-time">
          <label for="race-start-time-input">Start time (UTC)${dateStr ? ` <span class="race-date">${dateStr}</span>` : ''}</label>
          <input type="text" id="race-start-time-input" placeholder="HH:MM:SS" value="${startTimeVal}" autocomplete="off">
          <button id="btn-race-from-playback">← playback</button>
        </div>
      </div>
      <div class="race-section">
        <h3>Finish Line</h3>
        <div class="race-radio-group">${radioRow('race-finish', raceFinishPreset)}</div>
        <button id="btn-place-finish"${raceFinishPreset !== 'custom' ? ' class="hidden-control"' : ''}>Place on map ↗</button>
      </div>`;

    el.querySelectorAll('input[name="race-start"]').forEach(r => {
      r.addEventListener('change', () => {
        raceStartPreset = r.value;
        document.getElementById('btn-place-start').classList.toggle('hidden-control', raceStartPreset !== 'custom');
        raceStartLine = raceStartPreset !== 'custom' ? RACE_LINES[raceStartPreset] : null;
        MapManager.setRaceLine('start', raceStartLine);
        updateRaceDisplay();
      });
    });

    el.querySelectorAll('input[name="race-finish"]').forEach(r => {
      r.addEventListener('change', () => {
        raceFinishPreset = r.value;
        document.getElementById('btn-place-finish').classList.toggle('hidden-control', raceFinishPreset !== 'custom');
        raceFinishLine = raceFinishPreset !== 'custom' ? RACE_LINES[raceFinishPreset] : null;
        MapManager.setRaceLine('finish', raceFinishLine);
        updateRaceDisplay();
      });
    });

    document.getElementById('btn-place-start').addEventListener('click', () => {
      if (rulerMode) { rulerMode = false; elBtnRuler.classList.remove('active'); MapManager.deactivateRuler(); }
      switchView('map');
      MapManager.activateLinePlacer(coords => {
        raceStartPreset = 'custom';
        raceStartLine   = { a: { lat: coords.a.lat, lon: coords.a.lng }, b: { lat: coords.b.lat, lon: coords.b.lng } };
        MapManager.setRaceLine('start', raceStartLine);
        switchView('race');
        updateRaceDisplay();
      });
    });

    document.getElementById('btn-place-finish').addEventListener('click', () => {
      if (rulerMode) { rulerMode = false; elBtnRuler.classList.remove('active'); MapManager.deactivateRuler(); }
      switchView('map');
      MapManager.activateLinePlacer(coords => {
        raceFinishPreset = 'custom';
        raceFinishLine   = { a: { lat: coords.a.lat, lon: coords.a.lng }, b: { lat: coords.b.lat, lon: coords.b.lng } };
        MapManager.setRaceLine('finish', raceFinishLine);
        switchView('race');
        updateRaceDisplay();
      });
    });

    document.getElementById('race-start-time-input').addEventListener('input', e => {
      const refTs = boats.size > 0 ? boats.values().next().value.boat.minTs : Date.now();
      raceStartTime = parseUTCTime(e.target.value, refTs);
      updateRaceDisplay();
    });

    document.getElementById('btn-race-from-playback').addEventListener('click', () => {
      const ts = Playback.getState().currentTs;
      raceStartTime = ts;
      document.getElementById('race-start-time-input').value = fmtUTC(ts);
      updateRaceDisplay();
    });
  }

  function renderRaceResults(results) {
    const el = document.getElementById('race-results');
    if (!el) return;

    if (!results || boats.size === 0) {
      el.innerHTML = '<p class="race-no-data">No log files loaded.</p>';
      return;
    }

    // Earliest start crossing for elapsed calculation
    let firstStartTs = null;
    for (const { startCrossings } of results) {
      for (const c of startCrossings) {
        if (firstStartTs === null || c.ts < firstStartTs) firstStartTs = c.ts;
      }
    }

    const startLabel = raceStartTime
      ? `Start crossings after ${fmtUTC(raceStartTime)} UTC`
      : 'Start crossings (no start time set — showing all)';

    const hasStart  = results.some(r => r.startCrossings.length  > 0);
    const hasFinish = results.some(r => r.finishCrossings.length > 0);

    let html = `<div class="race-results-section"><h3>${startLabel}</h3>`;
    if (!hasStart) {
      html += `<p class="race-no-data">No crossings detected${!raceStartLine ? ' — start line not defined' : ''}.</p>`;
    } else {
      html += `<table class="race-table"><thead><tr>
        <th>Boat</th><th>Time (UTC)</th><th>From gun</th>
      </tr></thead><tbody>`;
      for (const { name, color, startCrossings } of results) {
        for (const c of startCrossings) {
          const fromGun = raceStartTime !== null ? fmtDuration(c.ts - raceStartTime) : '—';
          html += `<tr>
            <td><span class="race-boat-swatch" style="background:${color}"></span>${name}</td>
            <td>${fmtUTC(c.ts)}</td>
            <td>${fromGun}</td>
          </tr>`;
        }
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;

    html += `<div class="race-results-section"><h3>Finish crossings</h3>`;
    if (!hasFinish) {
      html += `<p class="race-no-data">No crossings detected${!raceFinishLine ? ' — finish line not defined' : ''}.</p>`;
    } else {
      html += `<table class="race-table"><thead><tr>
        <th>Boat</th><th>Time (UTC)</th><th>Elapsed</th>
      </tr></thead><tbody>`;
      for (const { name, color, finishCrossings } of results) {
        for (const c of finishCrossings) {
          const elapsed = firstStartTs !== null ? fmtElapsed(c.ts - firstStartTs) : '—';
          html += `<tr>
            <td><span class="race-boat-swatch" style="background:${color}"></span>${name}</td>
            <td>${fmtUTC(c.ts)}</td>
            <td>${elapsed}</td>
          </tr>`;
        }
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;

    el.innerHTML = html;
  }

  function updateRaceDisplay() {
    const results = computeRaceResults();
    // Always keep crossing markers on the map up-to-date
    MapManager.setRaceCrossings(
      results.flatMap(r => [
        ...r.startCrossings.map(c => ({ lat: c.lat, lon: c.lon, color: r.color })),
        ...r.finishCrossings.map(c => ({ lat: c.lat, lon: c.lon, color: r.color })),
      ])
    );
    if (currentView === 'race') renderRaceResults(results);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
