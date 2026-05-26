// Expedition CSV parser — runs client-side via File API
const Parser = (() => {

  const BOAT_COLORS = ['#1e88e5', '#e53935', '#43a047', '#fb8c00', '#8e24aa', '#00acc1'];
  let colorIndex = 0;

  function oleToMs(ole) {
    return (ole - 25569) * 86400 * 1000;
  }

  // opts.keepNames: optional Set of field names to retain (drops anything else
  //   before parseFloat). Lat/Lon are always implicitly kept.
  // opts.minSpacingMs: minimum ms between kept rows. Decimates frequency-based
  //   — a log already sparser than the threshold passes through untouched.
  // opts.fleetOnly is intentionally absent: AIS / fleet rows are dropped
  //   unconditionally for now (see the row-loop comment).
  function parse(text, name, opts) {
    const keepNames    = opts && opts.keepNames;
    const minSpacingMs = (opts && opts.minSpacingMs) || 0;
    const lines = text.split(/\r?\n/);

    // Line 0: !Boat,Utc,BSP,AWA,...
    // Line 1: !boat,0,1,2,3,...
    const colNames = lines[0].replace(/^!/, '').split(',');
    const rawIds   = lines[1].replace(/^!boat,/, '').split(',');

    const fieldMap = {};      // id → name  (after allowlist filter)
    const nameToId = {};      // name → id  (after allowlist filter; Lat/Lon
                              //  forced in below so the GPS resolution works
                              //  even if the caller's allowlist omits them)
    for (let i = 0; i < rawIds.length; i++) {
      const id  = parseInt(rawIds[i].trim(), 10);
      const nm  = colNames[i + 1] ? colNames[i + 1].trim() : `field_${id}`;
      if (!isNaN(id) && (!keepNames || keepNames.has(nm) || nm === 'Lat' || nm === 'Lon' || nm === 'Mk Lat' || nm === 'Mk Lon')) {
        fieldMap[id] = nm;
        nameToId[nm] = id;
      }
    }

    // Priority: named 'Lat'/'Lon' first, then 'Mk Lat'/'Mk Lon', then
    // hardcoded fallbacks (some old logs don't name the columns).
    const latId = nameToId['Lat']    !== undefined ? nameToId['Lat']
                : nameToId['Mk Lat'] !== undefined ? nameToId['Mk Lat']
                : 48;
    const lonId = nameToId['Lon']    !== undefined ? nameToId['Lon']
                : nameToId['Mk Lon'] !== undefined ? nameToId['Mk Lon']
                : 49;

    // Integer-indexed lookup of kept field IDs; faster than Set.has and
    // avoids a per-call hash on every column in the hot loop.
    let keptIds = null;
    if (keepNames) {
      keptIds = Object.create(null);
      for (const nm in nameToId) keptIds[nameToId[nm]] = 1;
      keptIds[latId] = 1;
      keptIds[lonId] = 1;
    }

    const rows = [];
    let lastKeptTs = -Infinity;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // Cheap char-level guards before any split / trim: skip header lines
      // (start with '!' = 33) and AIS / fleet rows (any boatId other than '0' =
      // 48 followed by a comma at index 1). On logs with heavy fleet traffic
      // this drops 10%+ of the line-loop work before any parsing happens.
      const c0 = line.charCodeAt(0);
      if (c0 === 33) continue;
      if (c0 !== 48 || line.charCodeAt(1) !== 44) continue;

      const cols = line.split(',');
      if (cols.length < 4) continue;

      const ole = parseFloat(cols[1]);
      if (isNaN(ole)) continue;

      const ts = oleToMs(ole);

      if (minSpacingMs > 0) {
        if (ts < lastKeptTs + minSpacingMs) continue;
        lastKeptTs = ts;
      }

      const fields = {};
      for (let j = 2; j + 1 < cols.length; j += 2) {
        const fid = parseInt(cols[j], 10);
        if (isNaN(fid)) continue;
        if (keptIds && !keptIds[fid]) continue;
        const val = parseFloat(cols[j + 1]);
        if (!isNaN(val)) fields[fid] = val;
      }

      const lat = fields[latId];
      const lon = fields[lonId];

      const row = { ts, fields };
      if (lat !== undefined && lon !== undefined) {
        row.lat = lat;
        row.lon = lon;
      }
      rows.push(row);
    }

    rows.sort((a, b) => a.ts - b.ts);

    const rawGpsRows = rows.filter(r => r.lat !== undefined);

    // Remove isolated GPS spikes: a point where BOTH the jump from the previous
    // AND the jump to the next exceed a threshold is physically impossible at boat
    // speeds and is a bad fix (e.g. sign-bit flip, momentary receiver glitch).
    const SPIKE_DEG = 0.05; // ~5 km — well above any real 1-second movement
    const gpsRows = rawGpsRows.filter((r, i, a) => {
      if (i === 0 || i === a.length - 1) return true;
      const d1 = Math.abs(r.lat - a[i-1].lat) + Math.abs(r.lon - a[i-1].lon);
      const d2 = Math.abs(r.lat - a[i+1].lat) + Math.abs(r.lon - a[i+1].lon);
      return !(d1 > SPIKE_DEG && d2 > SPIKE_DEG);
    });

    const color = BOAT_COLORS[colorIndex % BOAT_COLORS.length];
    colorIndex++;

    return {
      name,
      color,
      fieldMap,
      nameToId,
      rows,
      gpsRows,
      minTs: rows.length ? rows[0].ts : 0,
      maxTs: rows.length ? rows[rows.length - 1].ts : 0,
    };
  }

  function resetColors() {
    colorIndex = 0;
  }

  return { parse, resetColors };
})();
