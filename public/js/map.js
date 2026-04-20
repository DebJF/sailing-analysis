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
        e.marker.setIcon(buildBoatIcon(e.boat.color, e.heading ?? 0));
      }
    });

    L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a> contributors',
      maxZoom: 18,
      opacity: 0.9,
    }).addTo(map);

    new NmScaleControl().addTo(map);
  }

  const NmScaleControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd(m) {
      this._m  = m;
      this._el = L.DomUtil.create('div', 'nm-scale-bar');
      m.on('zoomend moveend', this._update, this);
      this._update();
      return this._el;
    },
    onRemove(m) {
      m.off('zoomend moveend', this._update, this);
    },
    _update() {
      const bounds = this._m.getBounds();
      const mPerPx = this._m.distance(bounds.getSouthWest(), bounds.getSouthEast()) / this._m.getSize().x;
      const maxNm  = mPerPx * 150 / 1852;
      const steps  = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
      let nm = steps[0];
      for (const s of steps) { if (s <= maxNm) nm = s; else break; }
      this._el.style.width = Math.round(nm * 1852 / mPerPx) + 'px';
      this._el.textContent = nm + ' nm';
    },
  });

  function addBoat(boat) {
    if (entries.has(boat.name)) removeBoat(boat.name);

    const latlngs = boat.gpsRows.map(r => [r.lat, r.lon]);

    const polyline = L.polyline(latlngs, {
      color: boat.color,
      weight: 3,
      opacity: 0.75,
    }).addTo(map);


    const startPos = latlngs.length > 0 ? latlngs[0] : [50.78, -1.22];
    const marker = L.marker(startPos, {
      icon: buildBoatIcon(boat.color, 0),
      zIndexOffset: 1000,
    }).addTo(map).bindTooltip(boat.name, { permanent: false, direction: 'top' });

    entries.set(boat.name, { boat, polyline, marker, trimPolyline: null, tackPolylines: [], windMarkers: [], windBarbs: [], heading: 0 });

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

  const BOAT_VW = 14, BOAT_VH = 24;

  function buildBoatIcon(color, heading) {
    const s  = barbScale();
    const W  = Math.round(BOAT_VW * s);
    const H  = Math.round(BOAT_VH * s);
    const ax = Math.round(W / 2);
    const ay = Math.round(H / 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${BOAT_VW} ${BOAT_VH}"><path d="M 7,1 C 13,8 13,17 11,22 L 3,22 C 1,17 1,8 7,1 Z" fill="${color}" stroke="#fff" stroke-width="1.5"/></svg>`;
    const html = `<div style="width:${W}px;height:${H}px;transform:rotate(${heading}deg);transform-origin:${ax}px ${ay}px">${svg}</div>`;
    return L.divIcon({ html, className: '', iconSize: [W, H], iconAnchor: [ax, ay] });
  }

  function updateMarker(boat, ts, heading) {
    const e = entries.get(boat.name);
    if (!e) return;
    const gps = boat.gpsRows;
    if (gps.length === 0) return;

    e.heading = heading ?? 0;

    if (ts <= gps[0].ts) {
      e.marker.setLatLng([gps[0].lat, gps[0].lon]);
    } else {
      const last = gps[gps.length - 1];
      if (ts >= last.ts) {
        e.marker.setLatLng([last.lat, last.lon]);
      } else {
        // Binary search for surrounding rows
        let lo = 0, hi = gps.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (gps[mid].ts <= ts) lo = mid; else hi = mid;
        }
        const t0 = gps[lo].ts, t1 = gps[hi].ts;
        const frac = t1 > t0 ? (ts - t0) / (t1 - t0) : 0;
        e.marker.setLatLng([
          gps[lo].lat + frac * (gps[hi].lat - gps[lo].lat),
          gps[lo].lon + frac * (gps[hi].lon - gps[lo].lon),
        ]);
      }
    }

    // Update rotation directly on the DOM element — avoids rebuilding SVG every tick
    const inner = e.marker._icon?.firstChild;
    if (inner) inner.style.transform = `rotate(${e.heading}deg)`;
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

  // ── Ruler ─────────────────────────────────────────────────────────────────────

  let _rulerOn    = false;
  let _rulerWait  = false;   // true = A placed, awaiting B
  let _rulerA     = null;
  let _rulerElems = [];      // locked measurement layers (cleared on new measurement start)
  let _rulerGhost = null;    // rubber-band line while moving

  function _rulerFmt(metres) {
    const nm = metres / 1852;
    return nm >= 0.5 ? nm.toFixed(2) + '\u00a0nm' : Math.round(metres) + '\u00a0m';
  }

  function _rulerClearLocked() {
    _rulerElems.forEach(el => el.remove());
    _rulerElems = [];
  }

  function _rulerOnClick(e) {
    if (!_rulerWait) {
      _rulerClearLocked();
      if (_rulerGhost) { _rulerGhost.remove(); _rulerGhost = null; }
      _rulerA    = e.latlng;
      _rulerWait = true;
      _rulerElems.push(
        L.circleMarker(e.latlng, { radius: 4, color: '#1e88e5', fillColor: '#1e88e5', fillOpacity: 1, weight: 2 }).addTo(map)
      );
    } else {
      const B    = e.latlng;
      const dist = map.distance(_rulerA, B);
      const mid  = L.latLng((_rulerA.lat + B.lat) / 2, (_rulerA.lng + B.lng) / 2);
      _rulerElems.push(
        L.circleMarker(B, { radius: 4, color: '#1e88e5', fillColor: '#1e88e5', fillOpacity: 1, weight: 2 }).addTo(map),
        L.polyline([_rulerA, B], { color: '#1e88e5', weight: 2, dashArray: '6 4' }).addTo(map),
        L.marker(mid, {
          icon: L.divIcon({ html: `<div class="ruler-label">${_rulerFmt(dist)}</div>`, className: '' }),
          interactive: false,
          zIndexOffset: 2000,
        }).addTo(map)
      );
      if (_rulerGhost) { _rulerGhost.remove(); _rulerGhost = null; }
      _rulerWait = false;
    }
  }

  function _rulerOnMove(e) {
    if (!_rulerWait) return;
    if (!_rulerGhost) {
      _rulerGhost = L.polyline([_rulerA, e.latlng], { color: '#1e88e5', weight: 1.5, dashArray: '4 4', opacity: 0.55 }).addTo(map);
    } else {
      _rulerGhost.setLatLngs([_rulerA, e.latlng]);
    }
  }

  function activateRuler() {
    if (_rulerOn) return;
    _rulerOn = true;
    map.getContainer().style.cursor = 'crosshair';
    map.on('click',     _rulerOnClick);
    map.on('mousemove', _rulerOnMove);
  }

  function deactivateRuler() {
    if (!_rulerOn) return;
    _rulerOn = false;
    map.getContainer().style.cursor = '';
    map.off('click',     _rulerOnClick);
    map.off('mousemove', _rulerOnMove);
    _rulerClearLocked();
    if (_rulerGhost) { _rulerGhost.remove(); _rulerGhost = null; }
    _rulerWait = false;
    _rulerA    = null;
  }

  function invalidateSize() { if (map) map.invalidateSize(); }

  // ── Race line overlays ────────────────────────────────────────────────────────

  let _startLineElems = [];
  let _finishLineElems = [];
  let _crossingElems  = [];

  function setRaceLine(type, coords) {
    const isStart = type === 'start';
    (isStart ? _startLineElems : _finishLineElems).forEach(el => el.remove());
    if (isStart) _startLineElems = []; else _finishLineElems = [];
    if (!coords) return;

    const color = '#000000';
    const label = type === 'start' ? 'Start' : 'Finish';
    const a   = [coords.a.lat, coords.a.lon];
    const b   = [coords.b.lat, coords.b.lon];
    const mid = [(coords.a.lat + coords.b.lat) / 2, (coords.a.lon + coords.b.lon) / 2];

    const newElems = [
      L.polyline([a, b], { color, weight: 2.5, dashArray: '8 5', opacity: 0.9 }).addTo(map),
      L.circleMarker(a, { radius: 5, color, fillColor: color, fillOpacity: 0.9, weight: 2 }).addTo(map),
      L.circleMarker(b, { radius: 5, color, fillColor: color, fillOpacity: 0.9, weight: 2 }).addTo(map),
      L.marker(mid, {
        icon: L.divIcon({
          html: `<div class="race-line-label" style="background:${color}">${label}</div>`,
          className: '',
        }),
        interactive: false,
        zIndexOffset: 1500,
      }).addTo(map),
    ];

    if (isStart) _startLineElems = newElems; else _finishLineElems = newElems;
  }

  function setRaceCrossings(crossings) {
    _crossingElems.forEach(el => el.remove());
    _crossingElems = crossings.map(({ lat, lon, color }) =>
      L.circleMarker([lat, lon], {
        radius: 5, color: '#fff', fillColor: color, fillOpacity: 1, weight: 1.5,
      }).addTo(map)
    );
  }

  // ── Line placer (two-click custom line placement) ──────────────────────────────

  let _placerActive   = false;
  let _placerWait     = false;
  let _placerA        = null;
  let _placerGhost    = null;
  let _placerTmpElems = [];
  let _placerCallback = null;

  function _placerHint(msg) {
    const el = document.getElementById('line-placer-hint');
    if (!el) return;
    if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
    else       el.classList.add('hidden');
  }

  function _placerClear() {
    _placerTmpElems.forEach(el => el.remove());
    _placerTmpElems = [];
  }

  function _placerOnClick(e) {
    if (!_placerWait) {
      _placerClear();
      if (_placerGhost) { _placerGhost.remove(); _placerGhost = null; }
      _placerA    = e.latlng;
      _placerWait = true;
      _placerTmpElems.push(
        L.circleMarker(e.latlng, { radius: 5, color: '#fff', fillColor: '#fff', fillOpacity: 0.9, weight: 2 }).addTo(map)
      );
      _placerHint('Click to place point 2 of 2');
    } else {
      const B = e.latlng;
      if (_placerGhost) { _placerGhost.remove(); _placerGhost = null; }
      const cb = _placerCallback;
      const A  = _placerA;
      deactivateLinePlacer();
      if (cb) cb({ a: A, b: B });
    }
  }

  function _placerOnMove(e) {
    if (!_placerWait) return;
    if (!_placerGhost) {
      _placerGhost = L.polyline([_placerA, e.latlng], { color: '#fff', weight: 1.5, dashArray: '4 4', opacity: 0.6 }).addTo(map);
    } else {
      _placerGhost.setLatLngs([_placerA, e.latlng]);
    }
  }

  function activateLinePlacer(callback) {
    if (_placerActive) deactivateLinePlacer();
    _placerActive   = true;
    _placerWait     = false;
    _placerA        = null;
    _placerCallback = callback;
    _placerClear();
    map.getContainer().style.cursor = 'crosshair';
    map.on('click',     _placerOnClick);
    map.on('mousemove', _placerOnMove);
    _placerHint('Click to place point 1 of 2');
  }

  function deactivateLinePlacer() {
    if (!_placerActive) return;
    _placerActive = false;
    map.getContainer().style.cursor = '';
    map.off('click',     _placerOnClick);
    map.off('mousemove', _placerOnMove);
    _placerClear();
    if (_placerGhost) { _placerGhost.remove(); _placerGhost = null; }
    _placerWait     = false;
    _placerA        = null;
    _placerCallback = null;
    _placerHint(null);
  }

  return { init, addBoat, removeBoat, updateMarker, setTrim, clearTrim, setTackMode, clearTackMode, showWindBarbs, hideWindBarbs, invalidateSize, activateRuler, deactivateRuler, setRaceLine, setRaceCrossings, activateLinePlacer, deactivateLinePlacer };
})();
