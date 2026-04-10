// Leaflet map manager
const MapManager = (() => {
  let map = null;
  // name → { boat, polyline, marker, trimPolyline }
  const entries = new Map();

  function init() {
    map = L.map('map', { zoomControl: true }).setView([50.78, -1.22], 12);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    map.on('zoomend', () => {
      for (const [, e] of entries) {
        if (e.windBarbs && e.windBarbs.length > 0) _renderWindBarbs(e);
      }
    });

    L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a> contributors',
      maxZoom: 18,
      opacity: 0.9,
    }).addTo(map);
  }

  function addBoat(boat) {
    if (entries.has(boat.name)) removeBoat(boat.name);

    const latlngs = boat.gpsRows.map(r => [r.lat, r.lon]);

    const polyline = L.polyline(latlngs, {
      color: boat.color,
      weight: 3,
      opacity: 0.75,
    }).addTo(map);


    const startPos = latlngs.length > 0 ? latlngs[0] : [50.78, -1.22];
    const marker = L.circleMarker(startPos, {
      radius: 8,
      fillColor: boat.color,
      color: '#fff',
      weight: 2,
      fillOpacity: 1,
      opacity: 1,
      zIndexOffset: 1000,
    }).addTo(map).bindTooltip(boat.name, { permanent: false, direction: 'top' });

    entries.set(boat.name, { boat, polyline, marker, trimPolyline: null, tackPolylines: [], windMarkers: [], windBarbs: [] });

    // Fit map to all tracks
    const allBounds = [];
    for (const [, e] of entries) {
      if (e.boat.gpsRows.length > 0) allBounds.push(e.polyline.getBounds());
    }
    if (allBounds.length > 0) {
      const combined = allBounds.reduce((acc, b) => acc.extend(b), allBounds[0]);
      map.fitBounds(combined, { padding: [30, 30] });
    }
  }

  function removeBoat(name) {
    const e = entries.get(name);
    if (!e) return;
    e.polyline.remove();
    e.marker.remove();
    if (e.trimPolyline) e.trimPolyline.remove();
    e.tackPolylines.forEach(p => p.remove());
    e.windMarkers.forEach(m => m.remove());
    entries.delete(name);
  }

  // segments: [{latlngs: [[lat,lon],...], color: '#...'}]
  function setTackMode(boat, segments) {
    const e = entries.get(boat.name);
    if (!e) return;
    e.tackPolylines.forEach(p => p.remove());
    e.tackPolylines = [];
    e.polyline.setStyle({ opacity: 0 });
    for (const seg of segments) {
      if (seg.latlngs.length < 2) continue;
      e.tackPolylines.push(
        L.polyline(seg.latlngs, { color: seg.color, weight: 3, opacity: 0.85 }).addTo(map)
      );
    }
  }

  function clearTackMode(boat) {
    const e = entries.get(boat.name);
    if (!e) return;
    e.tackPolylines.forEach(p => p.remove());
    e.tackPolylines = [];
    e.polyline.setStyle({ opacity: e.trimPolyline ? 0.15 : 0.75 });
  }

  function updateMarker(boat, ts) {
    const e = entries.get(boat.name);
    if (!e) return;
    const gps = boat.gpsRows;
    if (gps.length === 0) return;

    if (ts <= gps[0].ts) {
      e.marker.setLatLng([gps[0].lat, gps[0].lon]);
      return;
    }
    const last = gps[gps.length - 1];
    if (ts >= last.ts) {
      e.marker.setLatLng([last.lat, last.lon]);
      return;
    }

    // Binary search for surrounding rows
    let lo = 0, hi = gps.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (gps[mid].ts <= ts) lo = mid; else hi = mid;
    }
    const t0 = gps[lo].ts, t1 = gps[hi].ts;
    const frac = t1 > t0 ? (ts - t0) / (t1 - t0) : 0;
    const lat = gps[lo].lat + frac * (gps[hi].lat - gps[lo].lat);
    const lon = gps[lo].lon + frac * (gps[hi].lon - gps[lo].lon);
    e.marker.setLatLng([lat, lon]);
  }

  function setTrim(boat, startTs, endTs) {
    const e = entries.get(boat.name);
    if (!e) return;

    if (e.trimPolyline) { e.trimPolyline.remove(); e.trimPolyline = null; }

    const latlngs = boat.gpsRows
      .filter(r => r.ts >= startTs && r.ts <= endTs)
      .map(r => [r.lat, r.lon]);

    if (latlngs.length > 1) {
      e.polyline.setStyle({ opacity: 0.15 });
      e.trimPolyline = L.polyline(latlngs, {
        color: boat.color,
        weight: 3,
        opacity: 0.85,
      }).addTo(map);
    } else {
      e.polyline.setStyle({ opacity: 0.75 });
    }
  }

  function clearTrim(boat) {
    const e = entries.get(boat.name);
    if (!e) return;
    if (e.trimPolyline) { e.trimPolyline.remove(); e.trimPolyline = null; }
    e.polyline.setStyle({ opacity: 0.75 });
  }

  // ── Wind barbs ────────────────────────────────────────────────────────────────

  // Fixed viewBox geometry — width/height attributes control displayed size.
  // VW=14, VH=32: staff centre at x=7, station dot at y=30, upwind end at y=2.
  const BARB_VW = 14, BARB_VH = 32;

  function buildBarbSVG(tws, dispW, dispH) {
    const color = '#111';
    const sx = BARB_VW / 2;    // staff x in viewBox
    const stationY = BARB_VH - 2;
    const staffTopY = 2;

    let g = '';
    g += `<line x1="${sx}" y1="${stationY}" x2="${sx}" y2="${staffTopY}" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>`;
    g += `<circle cx="${sx}" cy="${stationY}" r="1.8" fill="${color}"/>`;

    let spd = Math.max(0, Math.round(tws));
    const pennants  = Math.floor(spd / 50); spd %= 50;
    const fullBarbs = Math.floor(spd / 10); spd %= 10;
    const halfBarb  = spd >= 5 ? 1 : 0;

    let y = staffTopY + 1;
    for (let i = 0; i < pennants; i++) {
      g += `<polygon points="${sx},${y} ${sx + 9},${y + 3} ${sx},${y + 6}" fill="${color}"/>`;
      y += 7;
    }
    for (let i = 0; i < fullBarbs; i++) {
      g += `<line x1="${sx}" y1="${y}" x2="${sx + 9}" y2="${y + 3}" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>`;
      y += 4;
    }
    if (halfBarb) {
      g += `<line x1="${sx}" y1="${y}" x2="${sx + 5}" y2="${y + 2}" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}" viewBox="0 0 ${BARB_VW} ${BARB_VH}">${g}</svg>`;
  }

  function barbScale() {
    // Scale barb size with zoom: zoom 10 → ~0.55×, zoom 12 → 1×, zoom 14 → ~1.8×
    const zoom = map.getZoom();
    return Math.max(0.4, Math.min(2.5, Math.pow(2, (zoom - 12) / 2.5)));
  }

  function makeWindBarbIcon(tws, twd) {
    const s  = barbScale();
    const W  = Math.round(BARB_VW * s);
    const H  = Math.round(BARB_VH * s);
    const ax = Math.round(W / 2);
    const ay = Math.round(H - 2 * s);   // station dot position after scaling
    const svg = buildBarbSVG(tws, W, H);
    const html = `<div style="width:${W}px;height:${H}px;transform:rotate(${twd}deg);transform-origin:${ax}px ${ay}px">${svg}</div>`;
    return L.divIcon({ html, className: 'wind-barb-icon', iconSize: [W, H], iconAnchor: [ax, ay] });
  }

  function _renderWindBarbs(e) {
    e.windMarkers.forEach(m => m.remove());
    e.windMarkers = (e.windBarbs || []).map(b =>
      L.marker([b.lat, b.lon], { icon: makeWindBarbIcon(b.tws, b.twd), interactive: false }).addTo(map)
    );
  }

  function showWindBarbs(boat, barbs) {
    const e = entries.get(boat.name);
    if (!e) return;
    e.windBarbs = barbs;
    _renderWindBarbs(e);
  }

  function hideWindBarbs(boat) {
    const e = entries.get(boat.name);
    if (!e) return;
    e.windMarkers.forEach(m => m.remove());
    e.windMarkers = [];
    e.windBarbs   = [];
  }

  function invalidateSize() { if (map) map.invalidateSize(); }

  return { init, addBoat, removeBoat, updateMarker, setTrim, clearTrim, setTackMode, clearTackMode, showWindBarbs, hideWindBarbs, invalidateSize };
})();
