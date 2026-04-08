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

    entries.set(boat.name, { boat, polyline, marker, trimPolyline: null });

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
    entries.delete(name);
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

  return { init, addBoat, removeBoat, updateMarker, setTrim, clearTrim };
})();
