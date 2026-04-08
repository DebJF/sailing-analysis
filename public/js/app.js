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

  // ── State ────────────────────────────────────────────────────────────────────

  // name → { boat, fieldTimeseries: Map<fieldId, [{ts,val}]> }
  const boats = new Map();

  // Field names visible in the variable panel
  let displayedVars = [...DEFAULT_VAR_NAMES];

  // All field names seen across all uploaded boats (name → fieldId in first boat that has it)
  const allFieldNames = new Map();

  // File queue for sequential name-prompt flow
  let fileQueue = [];

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  let elEmptyOverlay, elVarList, elAddVarSelect, elBoatList,
      elBtnPlay, elBtnRewind, elBtnFF,
      elBtnTrimStart, elBtnTrimEnd, elBtnClearTrim,
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
    elModal         = document.getElementById('name-modal');
    elModalFilename = document.getElementById('modal-filename');
    elBoatNameInput = document.getElementById('boat-name-input');
    elBtnModalOk    = document.getElementById('btn-modal-ok');

    MapManager.init();

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

    // Extend timeline range
    let { minTs, maxTs } = Playback.getState();
    const newMin = minTs === 0 ? boat.minTs : Math.min(minTs, boat.minTs);
    const newMax = maxTs === 0 ? boat.maxTs : Math.max(maxTs, boat.maxTs);
    Playback.setRange(newMin, newMax);

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

  // ── Playback callbacks ────────────────────────────────────────────────────────

  function onTick(ts) {
    for (const [, entry] of boats) {
      MapManager.updateMarker(entry.boat, ts);
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
