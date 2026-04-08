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

    // Lat/Lon candidate field IDs in priority order
    // The actual data in these log files uses Mk Lat (161) / Mk Lon (162) for GPS positions
    const latCandidates = [...new Set([
      nameToId['Lat'], nameToId['Mk Lat'], 48, 161,
    ].filter(v => v !== undefined))];
    const lonCandidates = [...new Set([
      nameToId['Lon'], nameToId['Mk Lon'], 49, 162,
    ].filter(v => v !== undefined))];

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

      // Resolve lat/lon using candidate IDs
      let lat, lon;
      for (const id of latCandidates) { if (fields[id] !== undefined) { lat = fields[id]; break; } }
      for (const id of lonCandidates) { if (fields[id] !== undefined) { lon = fields[id]; break; } }

      const row = { ts, fields };
      if (lat !== undefined && lon !== undefined) {
        row.lat = lat;
        row.lon = lon;
      }
      rows.push(row);
    }

    rows.sort((a, b) => a.ts - b.ts);
    const gpsRows = rows.filter(r => r.lat !== undefined);

    const color = BOAT_COLORS[colorIndex % BOAT_COLORS.length];
    colorIndex++;

    return {
      name,
      color,
      fieldMap,   // id → name
      nameToId,   // name → id
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
