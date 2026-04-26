// Polars tab: table + half-polar plot. Boat performance is assumed symmetric
// port to starboard, so all samples fold to the right half-disc and contribute
// to the same (TWA, BSP) cloud regardless of which tack they were observed on.
//   - sample overlay (Stage 2): all samples on the right half
//   - click-to-focus a single TWS (others fade)
//   - mouse-wheel zoom centred on the cursor; double-click resets zoom + pan + focus
//   - drag any point on the focused curve (or the upwind marker when nothing is
//     focused) to manually override its (TWA, BSP)
const PolarView = (() => {
  let tableEl, canvasEl, ctx;
  let currentPolar = null;
  let currentRefined = null;       // optional refined polar from PolarRefine.recommend
  let currentOptima = [];          // PolarRefine.detectOptimalAngles output (per TWS row)
  let currentSamples = [];
  let minShiftDeg = 2;             // suggestion threshold for optima
  let showSamples = true;
  let showRefined = true;
  let focusedTwsIndex = -1;       // -1 = no focus
  let zoom = 1;                    // 1 = full polar; >1 = zoomed in
  let panX = 0, panY = 0;          // pixel offsets from default centre

  // Drag state for manual point override; null when not dragging
  let dragState = null;
  let onPointDrop = null;

  // Hover tooltip target — the polar/refined point under the cursor, or null.
  // Stored as identity (twa, bsp, twsIdx) so the screen position is recomputed
  // each frame against the current layout (zoom/pan).
  let hoveredPoint = null;

  // Cached max BSP across the loaded polar's points; recomputed on setPolar.
  // Keeps _drawPlot() off the hot path of scanning every point per mouse move.
  let cachedMaxBsp = 0;

  const BG              = '#0f1923';
  const GRID            = '#3b5876';
  const AXIS            = '#4f6a85';
  const LABEL           = '#7fb3cc';
  const TITLE           = '#c8e6f5';
  const UPWIND_MARKER   = '#42a5f5';
  const DOWNWIND_MARKER = '#fb8c00';

  const TWS_COLORS = [
    '#66bb6a', '#26a69a', '#42a5f5', '#5c6bc0',
    '#ab47bc', '#ec407a', '#ef5350', '#ff7043',
    '#ffca28', '#9ccc65',
  ];

  const HIT_THRESHOLD = 16;
  const ZOOM_MIN = 0.5, ZOOM_MAX = 8, ZOOM_STEP = 1.15;

  function init(opts = {}) {
    tableEl  = document.getElementById('polars-table');
    canvasEl = document.getElementById('polars-canvas');
    ctx      = canvasEl.getContext('2d');
    onPointDrop = opts.onPointDrop || null;
    new ResizeObserver(() => { if (currentPolar) _drawPlot(); }).observe(canvasEl);

    canvasEl.addEventListener('mousedown',  _onMouseDown);
    canvasEl.addEventListener('mousemove',  _onMouseMove);
    canvasEl.addEventListener('mouseup',    _onMouseUp);
    canvasEl.addEventListener('mouseleave', _onMouseLeave);
    canvasEl.addEventListener('dblclick',   _onDblClick);
    canvasEl.addEventListener('wheel',      _onWheel, { passive: false });
  }

  function setPolar(polar) {
    currentPolar = polar;
    cachedMaxBsp = 0;
    if (polar) {
      for (const r of polar.rows) for (const p of r.points) if (p.bsp > cachedMaxBsp) cachedMaxBsp = p.bsp;
    }
    focusedTwsIndex = -1;
    hoveredPoint = null;
    zoom = 1; panX = 0; panY = 0;
    _drawTable();
    _drawPlot();
  }

  function setSamples(samples) {
    currentSamples = samples || [];
    hoveredPoint = null;
    _drawPlot();
  }

  function setRefined(refined) {
    currentRefined = refined;
    hoveredPoint = null;
    _drawTable();
    _drawPlot();
  }

  function setOptima(optima, shiftThresholdDeg) {
    currentOptima = optima || [];
    if (typeof shiftThresholdDeg === 'number') minShiftDeg = shiftThresholdDeg;
    hoveredPoint = null;
    _drawTable();
    _drawPlot();
  }


  function setShowSamples(show) {
    showSamples = !!show;
    _drawPlot();
  }

  function setShowRefined(show) {
    showRefined = !!show;
    _drawTable();
    _drawPlot();
  }

  function clear() {
    currentPolar = null;
    currentRefined = null;
    currentOptima = [];
    currentSamples = [];
    focusedTwsIndex = -1;
    zoom = 1; panX = 0; panY = 0;
    _drawTable();
    _drawPlot();
  }

  // ── Layout helpers ─────────────────────────────────────────────────────────

  function _chooseBspStep(maxBsp) {
    if (maxBsp <= 2)  return 0.25;
    if (maxBsp <= 4)  return 0.5;
    if (maxBsp <= 10) return 1;
    if (maxBsp <= 20) return 2;
    return 5;
  }

  // Returns geometry/scale for the polar plot. Half-disc layout: 0° at top,
  // 180° at bottom, 90° pointing right. The plot's centre sits near the left
  // edge so the half-disc can extend across the canvas. Port and starboard
  // performance is assumed symmetric — samples from both tacks contribute.
  function _computeLayout() {
    if (!canvasEl || !canvasEl.offsetWidth || !currentPolar) return null;

    const W = canvasEl.offsetWidth;
    const H = canvasEl.offsetHeight;

    const legendW        = 96;
    const leftMargin     = 28;
    const rightMargin    = 12;
    const verticalMargin = 24;

    const plotW       = W - legendW;
    const cxDefault   = leftMargin;
    const cyDefault   = H / 2;
    const cx          = cxDefault + panX;
    const cy          = cyDefault + panY;
    const rScale      = Math.max(20, Math.min(H / 2 - verticalMargin, plotW - cxDefault - rightMargin));

    const visibleMaxBsp = cachedMaxBsp / zoom;
    const bspStep       = _chooseBspStep(visibleMaxBsp);
    const maxR          = Math.max(bspStep, Math.ceil(visibleMaxBsp / bspStep) * bspStep);

    const toR     = (bsp) => (bsp / maxR) * rScale;
    const toAngle = (twa) => -Math.PI / 2 + (Math.abs(twa) * Math.PI / 180);
    const toXY    = (twa, bsp) => {
      const a = toAngle(twa), r = toR(bsp);
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };

    // Distance from (cx,cy) to where the ray at this angle exits the plot
    // rectangle [0,plotW] × [0,H]. Used to extend spokes and place outer
    // labels so they fill the visible area at any zoom.
    const radiusToEdge = (ang) => {
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      let upper = Infinity;
      if (Math.abs(cosA) > 0.001) {
        const limit = cosA > 0 ? (plotW - cx) / cosA : -cx / cosA;
        if (limit <= 0) return 0;
        upper = Math.min(upper, limit);
      }
      if (Math.abs(sinA) > 0.001) {
        const limit = sinA > 0 ? (H - cy) / sinA : -cy / sinA;
        if (limit <= 0) return 0;
        upper = Math.min(upper, limit);
      }
      return upper === Infinity ? 0 : upper;
    };

    return { W, H, plotW, legendW, cx, cy, cxDefault, cyDefault, rScale, maxR, bspStep, toR, toAngle, toXY, radiusToEdge };
  }

  // ── Hit testing ────────────────────────────────────────────────────────────

  function _distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function _hitTestCurves(layout, px, py) {
    let bestIdx = -1, bestDist = Infinity;
    currentPolar.rows.forEach((row, idx) => {
      let prev = null;
      for (const p of row.points) {
        const xy = layout.toXY(p.twa, p.bsp);
        if (prev) {
          const d = _distToSeg(px, py, prev[0], prev[1], xy[0], xy[1]);
          if (d < bestDist) { bestDist = d; bestIdx = idx; }
        }
        prev = xy;
      }
    });
    return bestDist <= HIT_THRESHOLD ? bestIdx : -1;
  }

  function _hitTestLegend(layout, px, py) {
    const lx = layout.plotW + 10;
    if (px < lx || px > lx + layout.legendW) return -1;
    const startY = 24 + 18; // matches legend layout in _drawPlot below
    for (let i = 0; i < currentPolar.rows.length; i++) {
      const ly = startY + i * 15;
      if (py >= ly - 2 && py <= ly + 12) return i;
    }
    return -1;
  }

  // Single-pass hit test: finds the closest polar/refined-polar point to
  // (px, py) within HIT_RADIUS. Returns enough info for both the hover
  // tooltip and a drag start. `draggable` reflects whether dragging this
  // point is allowed: any point on the focused row when focus is set, or
  // the row's upwind marker otherwise.
  const HIT_RADIUS = 10;
  function _hitTestPoint(layout, px, py) {
    const polar = (showRefined && currentRefined) ? currentRefined : currentPolar;
    if (!polar) return null;
    let best = null, bestDist = HIT_RADIUS;
    for (let idx = 0; idx < polar.rows.length; idx++) {
      if (focusedTwsIndex >= 0 && idx !== focusedTwsIndex) continue;
      const row = polar.rows[idx];
      for (const pt of row.points) {
        if (pt.bsp <= 0.01) continue;
        const [x, y] = layout.toXY(pt.twa, pt.bsp);
        const d = Math.hypot(px - x, py - y);
        if (d < bestDist) {
          bestDist = d;
          const isUpwind = row.upwind && Math.abs(row.upwind.twa - pt.twa) < 0.01;
          best = {
            twa:         pt.twa,
            bsp:         pt.bsp,
            twsIdx:      idx,
            tws:         row.tws,
            originalTwa: pt.originalTwa != null ? pt.originalTwa : pt.twa,
            draggable:   focusedTwsIndex >= 0 || isUpwind,
          };
        }
      }
    }
    return best;
  }

  function _sameHover(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.twsIdx === b.twsIdx
        && Math.abs(a.twa - b.twa) < 0.01
        && Math.abs(a.bsp - b.bsp) < 0.01;
  }

  // Convert canvas coords back to (twa, bsp). Drops on the left of cx are
  // pinned to the centreline (this is a half-disc plot — only the right side
  // is real; we fold |TWA|).
  function _canvasToPolar(px, py, layout) {
    const { cx, cy, rScale, maxR } = layout;
    const dx = Math.max(0.01, px - cx);
    const dy = py - cy;
    const r  = Math.hypot(dx, dy);
    if (r === 0 || rScale === 0) return null;
    const bsp = (r / rScale) * maxR;
    const canvasAngle = Math.atan2(dy, dx);
    let twa = (canvasAngle + Math.PI / 2) * 180 / Math.PI;
    if (twa < 1)   twa = 1;
    if (twa > 179) twa = 179;
    return { twa, bsp: Math.max(0.1, bsp) };
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  function _onMouseDown(e) {
    if (!currentPolar) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const layout = _computeLayout();
    if (!layout) return;

    const hit = _hitTestPoint(layout, x, y);
    if (hit && hit.draggable) {
      dragState = { twsIdx: hit.twsIdx, originalTwa: hit.originalTwa, startX: x, startY: y, currentX: x, currentY: y, didMove: false };
    } else {
      // No draggable point under cursor → mousedown starts a pan
      // (or a click if no movement before mouseup).
      dragState = { startX: x, startY: y, didMove: false, startPanX: panX, startPanY: panY };
    }
    if (hoveredPoint) hoveredPoint = null;   // hide hover tooltip while dragging
    canvasEl.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function _onMouseMove(e) {
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (dragState) {
      if (Math.hypot(x - dragState.startX, y - dragState.startY) > 3) dragState.didMove = true;
      if (dragState.twsIdx != null && dragState.didMove) {
        dragState.currentX = x;
        dragState.currentY = y;
        _drawPlot();
      } else if (dragState.twsIdx == null && dragState.didMove) {
        // Pan: shift cx/cy by the cursor delta since mousedown.
        panX = dragState.startPanX + (x - dragState.startX);
        panY = dragState.startPanY + (y - dragState.startY);
        _drawPlot();
      }
      return;
    }

    // Single hit-test serves both the cursor and the tooltip.
    const layout = _computeLayout();
    if (!layout) return;
    const hit = (x < layout.plotW) ? _hitTestPoint(layout, x, y) : null;

    if (hit && hit.draggable)  canvasEl.style.cursor = 'grab';
    else if (x < layout.plotW) canvasEl.style.cursor = 'move';
    else                       canvasEl.style.cursor = 'default';

    if (!_sameHover(hit, hoveredPoint)) {
      hoveredPoint = hit;
      _drawPlot();
    }
  }

  function _onMouseUp(e) {
    if (!dragState) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (dragState.twsIdx != null && dragState.didMove) {
      const layout = _computeLayout();
      if (layout && onPointDrop) {
        const point = _canvasToPolar(x, y, layout);
        if (point) onPointDrop(dragState.twsIdx, dragState.originalTwa, point.twa, point.bsp);
      }
    } else if (!dragState.didMove) {
      _handleClick(x, y);
    }

    dragState = null;
    canvasEl.style.cursor = 'default';
    _drawPlot();
  }

  function _onMouseLeave() {
    const needsRedraw = (dragState && dragState.twsIdx != null && dragState.didMove)
                     || hoveredPoint;
    dragState   = null;
    hoveredPoint = null;
    canvasEl.style.cursor = 'default';
    if (needsRedraw) _drawPlot();
  }

  function _handleClick(px, py) {
    const layout = _computeLayout();
    if (!layout) return;
    let idx = _hitTestCurves(layout, px, py);
    if (idx < 0) idx = _hitTestLegend(layout, px, py);
    if (idx >= 0) focusedTwsIndex = (focusedTwsIndex === idx) ? -1 : idx;
    else          focusedTwsIndex = -1;
    _drawTable();
    _drawPlot();
  }

  function _onDblClick() {
    zoom = 1; panX = 0; panY = 0;
    focusedTwsIndex = -1;
    _drawTable();
    _drawPlot();
  }

  function _onWheel(e) {
    if (!currentPolar) return;
    e.preventDefault();

    const factor  = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
    if (newZoom === zoom) return;

    const layout = _computeLayout();
    if (!layout) return;

    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Scale ratio = how much further from centre data appears after the zoom.
    const F = newZoom / zoom;

    // Keep the data point under the cursor at the same canvas coord:
    //   new_cx = (1 − F)·mx + F·old_cx
    const newCx = (1 - F) * mx + F * layout.cx;
    const newCy = (1 - F) * my + F * layout.cy;

    panX = newCx - layout.cxDefault;
    panY = newCy - layout.cyDefault;
    zoom = newZoom;

    _drawPlot();
  }

  // ── Table rendering ────────────────────────────────────────────────────────

  function _drawTable() {
    if (!tableEl) return;
    if (!currentPolar || currentPolar.rows.length === 0) {
      tableEl.innerHTML = '<p class="polars-empty">Load a polar (.pol) file to see the polar table.</p>';
      return;
    }

    const polar = currentPolar;
    const rows  = polar.rows;

    const colCls = (i) => {
      if (focusedTwsIndex < 0) return 'tws-clickable';
      if (i === focusedTwsIndex) return 'tws-focus tws-clickable';
      return 'tws-faded tws-clickable';
    };

    const refRows = (showRefined && currentRefined) ? currentRefined.rows : null;

    // Union of original and refined TWAs so any new TWA introduced by Stage 4
    // (e.g. moved upwind optimum) gets a row in the table.
    let twas = polar.allTwas;
    if (refRows && currentRefined.allTwas) {
      const set = new Set([...polar.allTwas, ...currentRefined.allTwas]);
      twas = [...set].sort((a, b) => a - b);
    }

    let html = '<table class="polars-data-table"><thead><tr><th>TWA \\ TWS</th>';
    rows.forEach((r, i) => {
      html += `<th class="${colCls(i)}" data-tws-idx="${i}">${r.tws.toFixed(1)}</th>`;
    });
    html += '</tr></thead><tbody>';

    for (const twa of twas) {
      html += `<tr><td class="twa-cell">${twa.toFixed(1)}°</td>`;
      rows.forEach((r, i) => {
        const pt    = r.points.find(p => Math.abs(p.twa - twa) < 0.01);
        const refR  = refRows ? refRows[i] : null;
        // up-opt / dn-opt highlight follows the refined polar's optima when
        // refining is on, otherwise the original polar's.
        const upRef = (refRows ? refR && refR.upwind   : r.upwind);
        const dnRef = (refRows ? refR && refR.downwind : r.downwind);
        const classes = [];
        if (upRef && Math.abs(upRef.twa - twa) < 0.01) classes.push('up-opt');
        if (dnRef && Math.abs(dnRef.twa - twa) < 0.01) classes.push('dn-opt');
        if (focusedTwsIndex >= 0) classes.push(i === focusedTwsIndex ? 'tws-focus' : 'tws-faded');

        let cellHtml = '';
        let style = '';
        let title = '';

        if (refRows) {
          // When refining, prefer the refined polar's value if present (the
          // new upwind TWA introduced by Stage 4 only exists in refined).
          const rPt = refR ? refR.points.find(p => Math.abs(p.twa - twa) < 0.01) : null;
          if (rPt && (rPt.shifted || rPt.manualOverride)) {
            cellHtml = rPt.bsp.toFixed(2);
            style = 'background: rgba(255, 193, 7, 0.28);';
            const sign = rPt.deltaPct >= 0 ? '+' : '';
            const provenance = rPt.manualOverride ? 'manual edit'
                            : `${rPt.sampleCount} samples`;
            const verb = rPt.manualOverride ? 'Upwind manually set' : 'Upwind optimum moved';
            title = `${verb}: was ${rPt.twaOld.toFixed(0)}° / ${rPt.bspOld.toFixed(2)}; now ${rPt.twa.toFixed(0)}° / ${rPt.bsp.toFixed(2)} (${sign}${rPt.deltaPct.toFixed(1)}%) · ${provenance}`;
            classes.push('refined');
            if (rPt.manualOverride) classes.push('manual-edit');
          } else if (rPt && rPt.recommended) {
            const dPct = rPt.deltaPct;
            cellHtml = rPt.bsp.toFixed(2);
            const intensity = Math.min(Math.abs(dPct) / 8, 1);
            const alpha = (0.18 + intensity * 0.45).toFixed(2);
            const rgb = dPct >= 0 ? '76, 175, 80' : '244, 67, 54';
            style = `background: rgba(${rgb}, ${alpha});`;
            const sign = dPct >= 0 ? '+' : '';
            title = `Old: ${rPt.bspOld.toFixed(2)} → New: ${rPt.bsp.toFixed(2)} (${sign}${dPct.toFixed(1)}%) · ${rPt.sampleCount} samples / ${Math.round(rPt.timeSpanSec)}s`;
            classes.push('refined');
          } else if (rPt && rPt.sampleCount > 0) {
            cellHtml = rPt.bsp.toFixed(2);
            title = `${rPt.sampleCount} samples${rPt.timeSpanSec ? ' / ' + Math.round(rPt.timeSpanSec) + 's' : ''} — below threshold, no recommendation`;
            classes.push('refined-insufficient');
          } else if (rPt) {
            cellHtml = rPt.bsp.toFixed(2);
          } else if (pt) {
            // Refined removed this TWA (e.g. upwind moved away) — show original
            // value greyed so the shift is visible.
            cellHtml = pt.bsp.toFixed(2);
            classes.push('refined-removed');
            title = 'Original value — entry removed in refined polar';
          }
        } else if (pt) {
          cellHtml = pt.bsp.toFixed(2);
        }

        html += `<td class="${classes.join(' ')}"${style ? ` style="${style}"` : ''}${title ? ` title="${title.replace(/"/g, '&quot;')}"` : ''}>${cellHtml}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table>';

    // Optimum-angle analysis (Stage 4)
    html += _renderOptimaTable();

    tableEl.innerHTML = html;

    tableEl.querySelectorAll('th[data-tws-idx]').forEach(th => {
      th.addEventListener('click', () => {
        const idx = parseInt(th.dataset.twsIdx, 10);
        focusedTwsIndex = (focusedTwsIndex === idx) ? -1 : idx;
        _drawTable();
        _drawPlot();
      });
    });
  }

  // ── Plot rendering ─────────────────────────────────────────────────────────

  function _drawPlot() {
    if (!canvasEl || !canvasEl.offsetWidth) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvasEl.offsetWidth;
    const H   = canvasEl.offsetHeight;
    canvasEl.width  = W * dpr;
    canvasEl.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    if (!currentPolar || currentPolar.rows.length === 0) {
      ctx.fillStyle = LABEL;
      ctx.font      = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No polar loaded', W / 2, H / 2);
      return;
    }

    const layout = _computeLayout();
    if (!layout) return;
    const { cx, cy, rScale, maxR, bspStep, plotW, legendW, toR, toAngle, toXY, radiusToEdge } = layout;

    // Clip drawing to the rectangular plot area (everything left of the
    // legend strip). When the user zooms in, points and curves extend beyond
    // the original half-disc boundary; the rectangular clip lets them stay
    // visible up to the legend, while keeping the legend itself protected.
    const clipPlotArea = () => {
      ctx.beginPath();
      ctx.rect(0, 0, plotW, H);
      ctx.closePath();
    };

    // BSP at which a ring would reach the farthest visible canvas corner —
    // used to extend rings (and their labels) beyond the original maxR when
    // the user zooms in or pans, so the visible area always has rings/labels.
    const farthestCornerR = Math.max(
      Math.hypot(0       - cx, 0 - cy),
      Math.hypot(plotW   - cx, 0 - cy),
      Math.hypot(0       - cx, H - cy),
      Math.hypot(plotW   - cx, H - cy),
    );
    const ringTopBsp = Math.ceil((farthestCornerR / rScale) * maxR / bspStep) * bspStep;

    // --- Radial grid (right-half BSP arcs) ---
    ctx.save();
    clipPlotArea();
    ctx.clip();

    ctx.strokeStyle = GRID;
    ctx.lineWidth   = 1;
    for (let b = bspStep; b <= ringTopBsp + 1e-9; b += bspStep) {
      ctx.beginPath();
      ctx.arc(cx, cy, toR(b), -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
    }

    // --- Angular spokes every 10° (major every 30°) — extend to canvas edge ---
    ctx.strokeStyle = GRID;
    for (let a = 0; a <= 180; a += 10) {
      const ang = toAngle(a);
      const isMajor = (a % 30 === 0);
      const spokeR  = radiusToEdge(ang);
      if (spokeR <= 0) continue;
      ctx.lineWidth   = isMajor ? 1   : 0.5;
      ctx.globalAlpha = isMajor ? 1   : 0.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * spokeR, cy + Math.sin(ang) * spokeR);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Central vertical axis (TWA 0°/180° line)
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(cx, cy - rScale);
    ctx.lineTo(cx, cy + rScale);
    ctx.stroke();

    // --- Sample dots — port and starboard fold to the same half-disc.
    // Boat performance assumed symmetric; both tacks contribute to the same
    // (TWA, BSP) cloud.
    if (showSamples && currentSamples.length) {
      for (const s of currentSamples) {
        const idx = _nearestTwsIndex(currentPolar.rows, s.tws);
        if (focusedTwsIndex >= 0 && idx !== focusedTwsIndex) continue;
        ctx.fillStyle   = TWS_COLORS[idx % TWS_COLORS.length];
        ctx.globalAlpha = 0.55;
        const [x, y] = toXY(s.twa, s.bsp);
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // --- TWS curves — original first, refined overlaid (when present) ---
    const refining = !!(showRefined && currentRefined);

    const drawRowCurve = (row, color, opts) => {
      ctx.strokeStyle = color;
      ctx.lineWidth   = opts.lineWidth;
      ctx.globalAlpha = opts.alpha;
      if (opts.dashed) ctx.setLineDash([4, 4]); else ctx.setLineDash([]);
      ctx.beginPath();
      row.points.forEach((p, i) => {
        const [x, y] = toXY(p.twa, p.bsp);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      if (opts.markers) {
        ctx.fillStyle = color;
        for (const p of row.points) {
          const [x, y] = toXY(p.twa, p.bsp);
          ctx.beginPath();
          ctx.arc(x, y, opts.markerR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.setLineDash([]);
    };

    currentPolar.rows.forEach((row, idx) => {
      // When a TWS is focused, hide all other curves entirely.
      if (focusedTwsIndex >= 0 && idx !== focusedTwsIndex) return;

      const isFocusedRow = (idx === focusedTwsIndex);
      const color = TWS_COLORS[idx % TWS_COLORS.length];
      const solidLW  = isFocusedRow ? 3   : 2;
      const dashedLW = isFocusedRow ? 3   : 1.5;
      const dashAlpha = isFocusedRow ? 1 : 0.4;
      const markerR  = isFocusedRow ? 2.5 : 1.6;

      if (refining) {
        drawRowCurve(row, color, {
          alpha:      dashAlpha,
          lineWidth:  dashedLW,
          dashed:     true,
          markers:    false,
        });
        const refRow = currentRefined.rows[idx];
        drawRowCurve(refRow, color, {
          alpha:      1,
          lineWidth:  solidLW,
          dashed:     false,
          markers:    true,
          markerR,
        });
      } else {
        drawRowCurve(row, color, {
          alpha:      1,
          lineWidth:  solidLW,
          dashed:     false,
          markers:    true,
          markerR,
        });
      }

      // Polar's stored VMG-optimum markers (circles) — visible when this row
      // is the focused one, or when nothing is focused.
      const isFocused = (focusedTwsIndex < 0) || isFocusedRow;
      if (isFocused) {
        ctx.globalAlpha = 1;
        if (row.upwind) {
          const [x, y] = toXY(row.upwind.twa, row.upwind.bsp);
          _drawHollowCircle(x, y, 5, UPWIND_MARKER);
        }
        if (row.downwind) {
          const [x, y] = toXY(row.downwind.twa, row.downwind.bsp);
          _drawHollowCircle(x, y, 5, DOWNWIND_MARKER);
        }
      }

      // Stage 4: observed-optimum markers (hollow diamonds), shown when a
      // detection exists — under no-focus mode they appear faded for non-
      // focused TWS, the same fade pattern as the curves.
      const optEntry = currentOptima[idx];
      if (optEntry && (optEntry.upwind || optEntry.downwind)) {
        ctx.globalAlpha = isFocused ? 1 : 0.18;
        if (optEntry.upwind) {
          const [x, y] = toXY(optEntry.upwind.observedTwa, optEntry.upwind.observedBsp);
          _drawDiamond(x, y, 6, UPWIND_MARKER);
        }
        if (optEntry.downwind) {
          const [x, y] = toXY(optEntry.downwind.observedTwa, optEntry.downwind.observedBsp);
          _drawDiamond(x, y, 6, DOWNWIND_MARKER);
        }
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    // --- Angular labels (drawn outside the clip so they aren't cropped) ---
    ctx.fillStyle    = LABEL;
    ctx.font         = '11px system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    // Scale label radius with zoom so they sit just outside the visible curves
    // rather than at the original-scale outer ring.
    const idealLabelR = (cachedMaxBsp / maxR) * rScale + 14;
    for (let a = 0; a <= 180; a += 30) {
      const ang     = toAngle(a);
      const edgeR   = radiusToEdge(ang);
      const labelR  = Math.min(idealLabelR, Math.max(20, edgeR - 12));
      ctx.fillText(a + '°', cx + Math.cos(ang) * labelR, cy + Math.sin(ang) * labelR);
    }

    // --- BSP ring labels (along the central vertical axis, above centre) ---
    // Iterate up to ringTopBsp so labels keep up with the extended rings, and
    // skip any whose position falls outside the visible plot area (off the top
    // when the user pans down, or to the right of the plot when cx is past
    // the legend, etc.).
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    const labelX = cx + 3;
    for (let b = bspStep; b <= ringTopBsp + 1e-9; b += bspStep) {
      const ly = cy - toR(b);
      if (ly < 4 || ly > H - 4) continue;
      if (labelX < 0 || labelX > plotW - 24) continue;
      const txt = bspStep < 1 ? b.toFixed(2) : b.toFixed(0);
      ctx.fillText(txt, labelX, ly);
    }

    // --- Legend (right strip) ---
    let ly = 24;
    const lx = plotW + 10;
    ctx.fillStyle    = TITLE;
    ctx.font         = '12px system-ui, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('TWS (kn)', lx, ly);
    ly += 18;

    ctx.font = '11px system-ui, sans-serif';
    currentPolar.rows.forEach((row, idx) => {
      const focused = focusedTwsIndex === idx;
      const dimmed  = focusedTwsIndex >= 0 && !focused;
      ctx.fillStyle   = TWS_COLORS[idx % TWS_COLORS.length];
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      ctx.fillRect(lx, ly + 4, 14, 3);
      ctx.fillStyle = focused ? TITLE : LABEL;
      ctx.fillText(row.tws.toFixed(1), lx + 20, ly);
      ctx.globalAlpha = 1;
      ly += 15;
    });

    ly += 10;
    _drawHollowCircle(lx + 7, ly + 5, 4, UPWIND_MARKER);
    ctx.fillStyle = LABEL;
    ctx.fillText('Upwind VMG', lx + 20, ly);
    ly += 16;
    _drawHollowCircle(lx + 7, ly + 5, 4, DOWNWIND_MARKER);
    ctx.fillStyle = LABEL;
    ctx.fillText('Downwind VMG', lx + 20, ly);

    if (currentOptima.length && currentOptima.some(o => o.upwind || o.downwind)) {
      ly += 16;
      _drawDiamond(lx + 7, ly + 5, 5, LABEL);
      ctx.fillStyle = LABEL;
      ctx.fillText('Observed opt.', lx + 20, ly);
    }

    // Zoom indicator
    if (Math.abs(zoom - 1) > 0.01) {
      ctx.fillStyle    = LABEL;
      ctx.font         = '10px system-ui, sans-serif';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`zoom ${zoom.toFixed(2)}× (dbl-click to reset)`, plotW - 6, 6);
    }

    // Hover tooltip — small label near the curve point under the cursor.
    // Suppressed during drag (the drag preview already shows TWA/BSP).
    if (hoveredPoint && !dragState) {
      const [hx, hy] = toXY(hoveredPoint.twa, hoveredPoint.bsp);
      const colorIdx = hoveredPoint.twsIdx % TWS_COLORS.length;
      const ringColor = TWS_COLORS[colorIdx];

      _drawHollowCircle(hx, hy, 5, ringColor);

      const text = `${hoveredPoint.twa.toFixed(0)}° / ${hoveredPoint.bsp.toFixed(2)} kn`;
      ctx.font = '11px system-ui, sans-serif';
      const padX = 6, padY = 3;
      const textW = ctx.measureText(text).width;
      const boxW  = textW + padX * 2;
      const boxH  = 18;
      let boxX = hx + 12;
      let boxY = hy - boxH - 6;
      if (boxX + boxW > plotW) boxX = hx - boxW - 12;
      if (boxY < 4)            boxY = hy + 10;

      ctx.fillStyle   = 'rgba(15, 25, 35, 0.92)';
      ctx.strokeStyle = ringColor;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.rect(boxX, boxY, boxW, boxH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle    = TITLE;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, boxX + padX, boxY + boxH / 2);
    }

    // Drag preview — large hollow marker following the cursor + (twa, bsp) label
    if (dragState && dragState.twsIdx != null && dragState.didMove) {
      const point = _canvasToPolar(dragState.currentX, dragState.currentY, layout);
      if (point) {
        const [px, py] = toXY(point.twa, point.bsp);
        _drawHollowCircle(px, py, 8, '#ffeb3b');
        ctx.strokeStyle = '#ffeb3b';
        ctx.beginPath(); ctx.moveTo(px - 12, py); ctx.lineTo(px + 12, py); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py - 12); ctx.lineTo(px, py + 12); ctx.stroke();

        ctx.fillStyle    = '#ffeb3b';
        ctx.font         = '11px system-ui, sans-serif';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${point.twa.toFixed(0)}° / ${point.bsp.toFixed(2)} kn`, px + 12, py - 8);
      }
    }
  }

  function _drawDiamond(x, y, r, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(x,     y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x,     y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.stroke();
  }

  function _drawHollowCircle(x, y, r, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function _renderOptimaTable() {
    if (!currentOptima.length) return '';

    const refRows = (showRefined && currentRefined) ? currentRefined.rows : null;

    // Prefer the refined polar's upwind/downwind when it carries a manual edit
    // or a Stage 4 auto-shift; otherwise fall back to the raw Stage 4 detection.
    function getObserved(twsIdx, side) {
      if (refRows) {
        const rRow  = refRows[twsIdx];
        const refPt = rRow ? rRow[side] : null;
        if (refPt && (refPt.manualOverride || refPt.shifted)) {
          return {
            observedTwa: refPt.twa,
            observedBsp: refPt.bsp,
            isManual:    !!refPt.manualOverride,
          };
        }
      }
      const opt = currentOptima[twsIdx];
      return opt ? opt[side] : null;
    }

    const observedAt = currentOptima.map((_, idx) => ({
      upwind:   getObserved(idx, 'upwind'),
      downwind: getObserved(idx, 'downwind'),
    }));

    if (!observedAt.some(o => o.upwind || o.downwind)) return '';

    let html = '<div class="polars-optima-title">Optimum angle analysis</div>';
    html += '<table class="polars-data-table polars-optima-table"><thead><tr>' +
      '<th rowspan="2">TWS</th>' +
      '<th colspan="3">Upwind</th><th colspan="3">Downwind</th>' +
      '</tr><tr>' +
      '<th>polar</th><th>obs</th><th>Δ°</th>' +
      '<th>polar</th><th>obs</th><th>Δ°</th>' +
      '</tr></thead><tbody>';

    currentOptima.forEach((o, i) => {
      html += `<tr><td class="twa-cell">${o.tws.toFixed(1)}</td>`;
      html += _optimumCells(o.polarUpwind,   observedAt[i].upwind);
      html += _optimumCells(o.polarDownwind, observedAt[i].downwind);
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function _optimumCells(polarOpt, observed) {
    const polarTxt = polarOpt
      ? `${polarOpt.twa.toFixed(0)}° / ${polarOpt.bsp.toFixed(2)}`
      : '—';
    if (!observed) return `<td>${polarTxt}</td><td>—</td><td>—</td>`;

    const obsTxt = `${observed.observedTwa.toFixed(0)}° / ${observed.observedBsp.toFixed(2)}`;
    const obsCls = observed.isManual ? ' class="manual-edit-cell"' : '';
    const title  = observed.isManual
      ? 'Manual edit'
      : `${observed.totalCount} samples · ${observed.binCount} bins · best bin ${observed.bestBinCount}`;

    let dTxt = '—', dCls = '';
    if (polarOpt) {
      const d = observed.observedTwa - polarOpt.twa;
      const sign = d > 0 ? '+' : '';
      dTxt = `${sign}${d.toFixed(0)}°`;
      if (Math.abs(d) >= minShiftDeg) dCls = 'optimum-shift';
    }
    return `<td>${polarTxt}</td>` +
      `<td${obsCls} title="${title.replace(/"/g, '&quot;')}">${obsTxt}</td>` +
      `<td class="${dCls}">${dTxt}</td>`;
  }

  function _nearestTwsIndex(rows, tws) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(rows[i].tws - tws);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  }

  return { init, setPolar, setRefined, setOptima, setSamples, setShowSamples, setShowRefined, clear };
})();
