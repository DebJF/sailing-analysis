// Main controller — wires parser, map, playback, and UI together
const App = (() => {

  // ── Constants ────────────────────────────────────────────────────────────────

  const UNITS = {
    BSP: 'kts', TWS: 'kts', AWS: 'kts', SOG: 'kts', VMG: 'kts',
    TWA: '°', AWA: '°', HDG: '°', COG: '°', TWD: '°', Heel: '°', Rudder: '°',
    'Pol0%': '%', 'VMG%': '%',
    Depth: 'm', Baro: 'hPa', Altitude: 'm',
  };

  const DEFAULT_VAR_NAMES = ['BSP', 'TWS', 'TWA', 'Pol0%'];

  const PORT_COLOR = '#e53935';
  const STBD_COLOR = '#43a047';

  // ── State ────────────────────────────────────────────────────────────────────

  // name → { boat, fieldTimeseries: Map<fieldId, [{ts,val}]> }
  const boats = new Map();

  // Field names visible in the variable panel
  let displayedVars = [...DEFAULT_VAR_NAMES];

  // All field names seen across all uploaded boats (name → fieldId in first boat that has it)
  const allFieldNames = new Map();

  // Active view: 'map' | 'beating'
  let currentView = 'map';

  // Whether track is coloured by tack
  let tackColorMode = false;

  // Wind barbs
  let windBarbsVisible = false;
  let windInterval = 10 * 60 * 1000; // 10 minutes in ms

  // File queue for sequential name-prompt flow
  let fileQueue = [];

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  let elEmptyOverlay, elVarList, elAddVarSelect, elBoatList,
      elBtnPlay, elBtnRewind, elBtnFF,
      elBtnTrimStart, elBtnTrimEnd, elBtnClearTrim, elBtnTackColor,
      elBtnWind, elWindInterval,
      elScrubber, elSpeedSelect, elTimeDisplay,
      elModal, elModalFilename, elBoatNameInput, elBtnModalOk;

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
    elModal         = document.getElementById('name-modal');
    elModalFilename = document.getElementById('modal-filename');
    elBoatNameInput = document.getElementById('boat-name-input');
    elBtnModalOk    = document.getElementById('btn-modal-ok');

    MapManager.init();
    Analysis.init();

    // View tabs
    document.getElementById('tab-map').addEventListener('click', () => switchView('map'));
    document.getElementById('tab-beating').addEventListener('click', () => switchView('beating'));
    document.getElementById('tab-twd').addEventListener('click', () => switchView('twd'));

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
      for (const [, entry] of boats) MapManager.clearTrim(entry.boat);
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

    // Modal
    elBtnModalOk.addEventListener('click', confirmBoatName);
    elBoatNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBoatName(); });
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
    if (currentView === 'twd') renderTwdTable();

    recalcPlaybackRange();
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

  function buildFieldTimeseries(boat) {
    // fieldId → [{ts, val}] sorted by ts (rows are already sorted)
    const map = {};
    for (const row of boat.rows) {
      for (const [fid, val] of Object.entries(row.fields)) {
        const id = parseInt(fid, 10);
        if (!map[id]) map[id] = [];
        map[id].push({ ts: row.ts, val });
      }
    }
    return map;
  }

  function getFieldValue(entry, fieldName, ts) {
    const fieldId = entry.boat.nameToId[fieldName];
    if (fieldId === undefined) return null;
    const series = entry.fieldTimeseries[fieldId];
    if (!series || series.length === 0) return null;
    return carryForward(series, ts);
  }

  function getFieldSeries(entry, fieldName) {
    const fieldId = entry.boat.nameToId[fieldName];
    if (fieldId === undefined) return null;
    return entry.fieldTimeseries[fieldId] || null;
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
    if (boats.size === 0) { Playback.setRange(0, 0); return; }
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
    document.getElementById('map-container').classList.toggle('view-hidden', view !== 'map');
    document.getElementById('analysis-container').classList.toggle('view-hidden', view !== 'beating');
    document.getElementById('twd-container').classList.toggle('view-hidden', view !== 'twd');
    if (view === 'map')     MapManager.invalidateSize();
    if (view === 'beating') Analysis.render(collectUpwindData());
    if (view === 'twd') renderTwdTable();
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
      lastTackTs = tackTs;

      const wasStarboard = prev.val > 0;
      const before = twdWindowStats(entry, tackTs - 60000, tackTs - 30000);
      const after  = twdWindowStats(entry, tackTs + 30000, tackTs + 60000);
      if (before === null || after === null) continue;

      tacks.push({
        ts:      tackTs,
        portTwd: wasStarboard ? after.mean  : before.mean,
        stbdTwd: wasStarboard ? before.mean : after.mean,
        unstable: before.range > 10 || after.range > 10,
      });
    }
    return tacks;
  }

  function renderTwdTable() {
    const el = document.getElementById('twd-content');
    if (boats.size === 0) {
      el.innerHTML = '<p class="twd-empty">No log files loaded.</p>';
      return;
    }
    let html = '';
    for (const [, entry] of boats) {
      const tacks = detectTacks(entry);
      html += `<div class="twd-boat-section">`;
      html += `<div class="twd-boat-header">
        <span class="boat-dot" style="background:${entry.boat.color}"></span>
        ${entry.boat.name}
      </div>`;
      if (tacks.length === 0) {
        html += `<p class="twd-empty">No tacks detected in the selected range.</p>`;
      } else {
        html += `<table class="twd-table">
          <thead><tr>
            <th>Time (UTC)</th>
            <th>Port TWD</th>
            <th>Starboard TWD</th>
            <th>Shift</th>
          </tr></thead><tbody>`;
        for (const t of tacks) {
          const d   = new Date(t.ts);
          const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
                        .map(n => String(n).padStart(2, '0')).join(':');
          const shift = normalizeAngle(t.portTwd - t.stbdTwd);
          const shiftStr = (shift >= 0 ? '+' : '') + shift.toFixed(1) + '°';
          const rowStyle = t.unstable ? ' style="color:#ef9a9a"' : '';
          html += `<tr${rowStyle}>
            <td>${hms}</td>
            <td>${t.portTwd.toFixed(1)}°</td>
            <td>${t.stbdTwd.toFixed(1)}°</td>
            <td>${shiftStr}</td>
          </tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
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

  // ── Playback callbacks ────────────────────────────────────────────────────────

  function onTick(ts) {
    for (const [, entry] of boats) {
      const hdg = getFieldValue(entry, 'HDG', ts) ?? getFieldValue(entry, 'COG', ts) ?? 0;
      MapManager.updateMarker(entry.boat, ts, hdg);
    }
    updateVariableValues(ts);
    updateScrubber(ts);
    updateTimeDisplay(ts);
  }

  function onTrimChange(start, end) {
    for (const [, entry] of boats) {
      MapManager.setTrim(entry.boat, start, end);
    }
    updateScrubberRange();
    if (currentView === 'beating') Analysis.render(collectUpwindData());
    if (currentView === 'twd') renderTwdTable();
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
      div.innerHTML = `
        <span class="boat-dot" style="background:${entry.boat.color}"></span>
        <span class="boat-name">${entry.boat.name}</span>
        <button class="btn-remove-boat" data-name="${entry.boat.name}" title="Remove">×</button>
      `;
      elBoatList.appendChild(div);
    }
    elBoatList.querySelectorAll('.btn-remove-boat').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        MapManager.removeBoat(name);
        boats.delete(name);
        recalcPlaybackRange();
        const st = Playback.getState();
        for (const [, entry] of boats) MapManager.clearTrim(entry.boat);
        onTick(st.currentTs);
        if (currentView === 'beating') Analysis.render(collectUpwindData());
        if (currentView === 'twd') renderTwdTable();
        renderBoatList();
        renderVariablePanel();
        updateAddVarDropdown();
      });
    });
  }

  function renderVariablePanel() {
    elVarList.innerHTML = '';
    const st = Playback.getState();

    for (const varName of displayedVars) {
      const unit = UNITS[varName] || '';
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
      values.id = `varval-${cssId(varName)}`;

      // Populate current values
      const boatVals = [];
      for (const [, entry] of boats) {
        const v = getFieldValue(entry, varName, st.currentTs);
        const formatted = v !== null ? formatVal(v, varName) + (unit ? '\u00a0' + unit : '') : '—';
        boatVals.push(`<span class="var-dot" style="background:${entry.boat.color}"></span><span class="var-num">${formatted}</span>`);
      }
      values.innerHTML = boatVals.join('');

      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(values);
      elVarList.appendChild(row);
    }
  }

  function updateVariableValues(ts) {
    for (const varName of displayedVars) {
      const el = document.getElementById(`varval-${cssId(varName)}`);
      if (!el) continue;
      const unit = UNITS[varName] || '';
      const boatVals = [];
      for (const [, entry] of boats) {
        const v = getFieldValue(entry, varName, ts);
        const formatted = v !== null ? formatVal(v, varName) + (unit ? '\u00a0' + unit : '') : '—';
        boatVals.push(`<span class="var-dot" style="background:${entry.boat.color}"></span><span class="var-num">${formatted}</span>`);
      }
      el.innerHTML = boatVals.join('');
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

  function formatVal(v, fieldName) {
    const unit = UNITS[fieldName] || '';
    if (unit === '°' || unit === '%') return v.toFixed(0);
    return v.toFixed(1);
  }

  function cssId(name) {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
