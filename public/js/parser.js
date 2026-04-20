// Expedition CSV parser — runs client-side via File API
const Parser = (() => {

  const BOAT_COLORS = ['#1e88e5', '#e53935', '#43a047', '#fb8c00', '#8e24aa', '#00acc1'];
  let colorIndex = 0;

  function oleToMs(ole) {
    return (ole - 25569) * 86400 * 1000;
  }

  function parse(text, name) {
    const lines = text.split(/\r?\n/);

    // Line 0: !Boat,Utc,BSP,AWA,...
    // Line 1: !boat,0,1,2,3,...
    const colNames = lines[0].replace(/^!/, '').split(',');
    const rawIds   = lines[1].replace(/^!boat,/, '').split(',');

    // Build bidirectional field maps (field ID is a number)
    const fieldMap = {};  // id → name
    const nameToId = {};  // name → id
    for (let i = 0; i < rawIds.length; i++) {
      const id  = parseInt(rawIds[i].trim(), 10);
      const nm  = colNames[i + 1] ? colNames[i + 1].trim() : `field_${id}`;
      if (!isNaN(id)) {
        fieldMap[id] = nm;
        nameToId[nm]  = id;
      }
    }

    // Pick ONE consistent lat/lon field ID for the whole file to avoid mixing
    // boat GPS position with mark/waypoint position across rows.
    // Priority: named 'Lat'/'Lon' first, then 'Mk Lat'/'Mk Lon', then hardcoded fallbacks.
    const latId = nameToId['Lat'] !== undefined ? nameToId['Lat']
                : nameToId['Mk Lat'] !== undefined ? nameToId['Mk Lat']
                : 48;
    const lonId = nameToId['Lon'] !== undefined ? nameToId['Lon']
                : nameToId['Mk Lon'] !== undefined ? nameToId['Mk Lon']
                : 49;

    const rows = [];

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('!')) continue;

      const cols = line.split(',');
      if (cols.length < 4) continue;

      const ole = parseFloat(cols[1]);
      if (isNaN(ole)) continue;

      const ts = oleToMs(ole);

      // Parse field-value pairs starting at column 2
      const fields = {};
      for (let j = 2; j + 1 < cols.length; j += 2) {
        const fid = parseInt(cols[j].trim(), 10);
        const val = parseFloat(cols[j + 1].trim());
        if (!isNaN(fid) && !isNaN(val)) {
          fields[fid] = val;
        }
      }

      // Resolve lat/lon using the single consistent field IDs
      const lat = fields[latId];
      const lon = fields[lonId];

      const row = { ts, fields, boatId: cols[0].trim() };
      if (lat !== undefined && lon !== undefined) {
        row.lat = lat;
        row.lon = lon;
      }
      rows.push(row);
    }

    rows.sort((a, b) => a.ts - b.ts);

    // In Expedition CSV, boatId '0' is always the own (primary) boat.
    // Other IDs are fleet/AIS contacts. If boat 0 is present, discard all other boats
    // so their GPS positions and any logged fields don't contaminate statistics.
    const ownRows = rows.filter(r => r.boatId === '0');
    const dataRows = ownRows.length > 0 ? ownRows : rows;

    const rawGpsRows = dataRows.filter(r => r.lat !== undefined);

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
      fieldMap,   // id → name
      nameToId,   // name → id
      rows: dataRows,
      gpsRows,
      minTs: dataRows.length ? dataRows[0].ts : 0,
      maxTs: dataRows.length ? dataRows[dataRows.length - 1].ts : 0,
    };
  }

  function resetColors() {
    colorIndex = 0;
  }

  return { parse, resetColors };
})();
