// Graph tab — time-series canvas renderer
const Graph = (() => {

  const BG         = '#0f1923';
  const GRID       = '#243d52';
  const LABEL      = '#7fb3cc';
  const TITLE      = '#c8e6f5';
  const PORT_COLOR = '#e53935';
  const STBD_COLOR = '#43a047';
  const GAP   = 8; // px between sub-plot bands
  const M     = { top: 12, right: 24, bottom: 40, left: 58 };

  // X-axis tick intervals in seconds
  const X_INTERVALS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

  // Upper bound on x-axis ticks / vertical gridlines, whatever the span.
  const MAX_X_TICKS = 400;

  let canvas = null;
  let offscreen = null; // stored base image (no cursor)
  let _lastData = null;
  let _onClick = null;

  function init({ onClick = null } = {}) {
    _onClick = onClick;
    canvas = document.getElementById('graph-canvas');
    new ResizeObserver(() => {
      if (_lastData) render(_lastData);
    }).observe(canvas);
    canvas.addEventListener('click', handleCanvasClick);
    canvas.addEventListener('mousemove', handleCanvasMouseMove);
    canvas.addEventListener('mouseleave', () => { canvas.style.cursor = ''; });
  }

  function _bandLayout() {
    if (!_lastData) return null;
    const n = _lastData.series.length;
    if (n === 0) return null;
    const H = canvas.offsetHeight;
    const plotH = H - M.top - M.bottom;
    const bandH = (plotH - GAP * (n - 1)) / n;
    return { n, bandH };
  }

  function _hitTestLabel(cx, cy) {
    const layout = _bandLayout();
    if (!layout) return -1;
    const { n, bandH } = layout;

    // Y-axis labels: left margin
    if (cx < M.left) {
      for (let i = 0; i < n; i++) {
        const bandTop = M.top + i * (bandH + GAP);
        if (cy >= bandTop && cy <= bandTop + bandH) return i;
      }
      return -1;
    }

    // X-axis label: bottom margin, within plot width
    const lastBandBottom = M.top + (n - 1) * (bandH + GAP) + bandH;
    const plotW = canvas.offsetWidth - M.left - M.right;
    if (cy > lastBandBottom && cx <= M.left + plotW) return n; // sentinel: n = x-axis

    return -1;
  }

  function handleCanvasClick(e) {
    if (!_onClick || !_lastData) return;
    const rect = canvas.getBoundingClientRect();
    const i = _hitTestLabel(e.clientX - rect.left, e.clientY - rect.top);
    if (i < 0) return;
    const varName = i < _lastData.series.length ? _lastData.series[i].varName : null;
    _onClick(varName, e.clientX, e.clientY);
  }

  function handleCanvasMouseMove(e) {
    if (!_lastData) { canvas.style.cursor = ''; return; }
    const rect = canvas.getBoundingClientRect();
    canvas.style.cursor = _hitTestLabel(e.clientX - rect.left, e.clientY - rect.top) >= 0 ? 'pointer' : '';
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function render(data) {
    _lastData = data;
    if (!canvas.offsetWidth || !canvas.offsetHeight) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;

    // Draw base chart to offscreen canvas
    offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    const octx = offscreen.getContext('2d');
    octx.scale(dpr, dpr);
    drawBase(octx, W, H, data);

    // Blit to main canvas + draw cursor
    const ctx = canvas.getContext('2d');
    ctx.drawImage(offscreen, 0, 0);
    if (data.series.length > 0) drawCursor(ctx, W, H, data.currentTs, data.xStart, data.xEnd, dpr);
  }

  function updateCursor(ts) {
    if (!_lastData || !offscreen || !canvas.offsetWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(offscreen, 0, 0);
    if (_lastData.series.length > 0) drawCursor(ctx, W, H, ts, _lastData.xStart, _lastData.xEnd, dpr);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────

  function drawBase(ctx, W, H, data) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const { series, xStart, xEnd, xScale } = data;

    if (series.length === 0 || series.every(s => s.boats.length === 0)) {
      ctx.fillStyle = LABEL;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data — upload a log file and select a variable', W / 2, H / 2);
      return;
    }

    const n = series.length;
    const plotW = W - M.left - M.right;
    const plotH = H - M.top  - M.bottom;
    const bandH = (plotH - GAP * (n - 1)) / n;

    const xSpan = xEnd - xStart;
    const toX = ts => M.left + (ts - xStart) / xSpan * plotW;
    const xInterval = computeXInterval(xStart, xEnd);

    // Draw each band
    series.forEach((s, i) => {
      const bandTop = M.top + i * (bandH + GAP);
      drawBand(ctx, s, bandTop, bandH, plotW, toX, xStart, xEnd, xInterval);
    });

    // Shared x-axis at bottom of last band
    const lastBandBottom = M.top + (n - 1) * (bandH + GAP) + bandH;
    const isManualX = xScale && xScale.mode === 'manual';
    drawXAxis(ctx, W, lastBandBottom, plotW, xStart, xEnd, toX, xInterval, isManualX);
  }

  function drawBand(ctx, s, bandTop, bandH, plotW, toX, xStart, xEnd, xInterval) {
    if (s.boats.length === 0) return;

    const isManual = s.scale && s.scale.mode === 'manual';
    let yMin, yMax;
    if (isManual) {
      yMin = s.scale.min;
      yMax = s.scale.max;
    } else {
      yMin = s.boats[0].min; yMax = s.boats[0].max;
      for (let i = 1; i < s.boats.length; i++) {
        if (s.boats[i].min < yMin) yMin = s.boats[i].min;
        if (s.boats[i].max > yMax) yMax = s.boats[i].max;
      }
      if (yMin === yMax) { yMin -= 1; yMax += 1; }
      const pad = (yMax - yMin) * 0.1;
      yMin -= pad;
      yMax += pad;
    }

    const toY = v => bandTop + (1 - (v - yMin) / (yMax - yMin)) * bandH;

    // Grid lines + y-axis ticks
    const { step, niceMin, niceMax } = niceScale(yMin, yMax, 8);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;

    // Horizontal grid lines
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const hTicks = [];
    for (let v = niceMin; v <= niceMax + step * 0.01; v += step) {
      if (v < yMin || v > yMax) continue;
      hTicks.push(v);
    }
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    for (const v of hTicks) {
      const py = toY(v);
      ctx.moveTo(M.left, py);
      ctx.lineTo(M.left + plotW, py);
    }
    ctx.stroke();
    ctx.fillStyle = LABEL;
    for (const v of hTicks) {
      ctx.fillText(formatTick(v, step), M.left - 5, toY(v));
    }

    // Vertical grid lines (aligned with x-axis ticks)
    if (xInterval) {
      const firstTick = Math.ceil(xStart / 1000 / xInterval) * xInterval * 1000;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      for (let ts = firstTick; ts <= xEnd; ts += xInterval * 1000) {
        const px = toX(ts);
        ctx.moveTo(px, bandTop);
        ctx.lineTo(px, bandTop + bandH);
      }
      ctx.stroke();
    }

    // Y-axis label (variable name + unit)
    const varDisplay = s.absTack ? `|${s.varName}|` : s.varName;
    const label = s.unit ? `${varDisplay} (${s.unit})` : varDisplay;
    ctx.save();
    ctx.fillStyle = isManual ? '#1e88e5' : TITLE;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.translate(12, bandTop + bandH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(label, 0, 0);
    ctx.restore();

    // Left axis line
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, bandTop);
    ctx.lineTo(M.left, bandTop + bandH);
    ctx.stroke();

    // Data lines
    s.boats.forEach(b => {
      if (b.points.length < 2) return;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';

      if (s.absTack && b.absTackPoints) {
        const pts = decimate(b.absTackPoints, plotW, xStart, xEnd);
        let i = 0;
        while (i < pts.length) {
          const segSign = pts.sign[i] >= 0 ? 1 : -1;
          ctx.strokeStyle = segSign >= 0 ? STBD_COLOR : PORT_COLOR;
          ctx.beginPath();
          ctx.moveTo(toX(pts.ts[i]), toY(pts.val[i]));
          let j = i + 1;
          while (j < pts.length && (pts.sign[j] >= 0 ? 1 : -1) === segSign) {
            ctx.lineTo(toX(pts.ts[j]), toY(pts.val[j]));
            j++;
          }
          // Extend one point into the next segment to avoid a gap at the zero crossing
          if (j < pts.length) ctx.lineTo(toX(pts.ts[j]), toY(pts.val[j]));
          ctx.stroke();
          i = j;
        }
      } else {
        ctx.strokeStyle = b.color;
        ctx.beginPath();
        const pts = decimate(b.points, plotW, xStart, xEnd);
        for (let i = 0; i < pts.length; i++) {
          const px = toX(pts.ts[i]);
          const py = toY(pts.val[i]);
          if (i === 0) ctx.moveTo(px, py);
          else         ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    });

    // Average legend — top-right of band
    const legendX = M.left + plotW - 4;
    let legendY = bandTop + 12;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    s.boats.forEach(b => {
      if (b.avg === null) return;
      const unit = s.unit;
      const dp = (unit === '°' || unit === '%') ? 0 : 1;
      const txt = b.avg.toFixed(dp) + (unit ? '\u00a0' + unit : '');
      const textW = ctx.measureText(txt).width;
      // dot
      const dotX = legendX - textW - 8;
      if (s.absTack) {
        ctx.fillStyle = PORT_COLOR;
        ctx.beginPath();
        ctx.arc(dotX, legendY, 3.5, Math.PI / 2, Math.PI * 3 / 2);
        ctx.fill();
        ctx.fillStyle = STBD_COLOR;
        ctx.beginPath();
        ctx.arc(dotX, legendY, 3.5, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
      } else {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(dotX, legendY, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // value
      ctx.fillStyle = TITLE;
      ctx.textAlign = 'right';
      ctx.fillText(txt, legendX, legendY);
      legendY += 15;
    });
  }

  function computeXInterval(trimStart, trimEnd) {
    const xSpanS = (trimEnd - trimStart) / 1000;
    if (!isFinite(xSpanS) || xSpanS <= 0) return null;
    let interval = X_INTERVALS_S[X_INTERVALS_S.length - 1];
    for (const s of X_INTERVALS_S) {
      if (xSpanS / s <= 7) { interval = s; break; }
    }
    // Hard ceiling on tick count. The table above tops out at one day, so a span
    // longer than MAX_X_TICKS days would queue millions of gridline segments into
    // a single canvas path and exhaust the tab's memory before anything is drawn.
    // Round the fallback up to whole days so labels stay on day boundaries.
    if (xSpanS / interval > MAX_X_TICKS) {
      interval = Math.ceil(xSpanS / MAX_X_TICKS / 86400) * 86400;
    }
    return interval;
  }

  function drawXAxis(ctx, W, axisY, plotW, xStart, xEnd, toX, xInterval, isManualX) {
    // Bottom axis line
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, axisY);
    ctx.lineTo(M.left + plotW, axisY);
    ctx.stroke();

    // Ticks
    if (!xInterval) return;
    const firstTick = Math.ceil(xStart / 1000 / xInterval) * xInterval * 1000;
    ctx.fillStyle = LABEL;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const dStart = new Date(xStart);
    const dEnd   = new Date(xEnd);
    const startDay = Date.UTC(dStart.getUTCFullYear(), dStart.getUTCMonth(), dStart.getUTCDate());
    const endDay   = Date.UTC(dEnd.getUTCFullYear(),   dEnd.getUTCMonth(),   dEnd.getUTCDate());
    const multiDay = endDay > startDay;
    let prevDay = null;

    for (let ts = firstTick; ts <= xEnd; ts += xInterval * 1000) {
      const px = toX(ts);
      const d = new Date(ts);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const label = xInterval < 60 ? `${hh}:${mm}:${String(d.getUTCSeconds()).padStart(2, '0')}` : `${hh}:${mm}`;
      ctx.beginPath();
      ctx.moveTo(px, axisY);
      ctx.lineTo(px, axisY + 4);
      ctx.stroke();
      ctx.fillText(label, px, axisY + 6);

      if (multiDay) {
        const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        if (day !== prevDay) {
          const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
          const da = String(d.getUTCDate()).padStart(2, '0');
          ctx.fillText(`${mo}-${da}`, px, axisY + 18);
          prevDay = day;
        }
      }
    }

    // Axis title — shift down in multi-day mode to clear the date row
    ctx.fillStyle = isManualX ? '#1e88e5' : TITLE;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Time (UTC)', M.left + plotW / 2, axisY + (multiDay ? 38 : 30));
  }

  function drawCursor(ctx, W, H, ts, xStart, xEnd, dpr) {
    if (ts < xStart || ts > xEnd) return;
    const plotW = W - M.left - M.right;
    const plotH = H - M.top  - M.bottom;
    const px = M.left + (ts - xStart) / (xEnd - xStart) * plotW;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, M.top);
    ctx.lineTo(px, M.top + plotH);
    ctx.stroke();
    ctx.restore();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Min/max decimation. A 12-day log holds ~1M samples per variable but the plot
  // is ~1400px wide, so all but ~2 samples per pixel column are drawn on top of
  // each other. Emitting the column's min and max (in timestamp order) keeps the
  // trace visually identical — peaks and troughs survive, which plain stride
  // sampling would drop — while cutting the canvas path by two-plus orders of
  // magnitude. `sign` is carried through when present so the port/starboard
  // segmenting in absTack mode still works off the decimated points.
  function decimate(pts, plotW, xStart, xEnd) {
    const n = pts.length;
    const cols = Math.max(1, Math.ceil(plotW));
    // Two points per column, plus two for the sample landing exactly on xEnd,
    // which falls outside the last column and so forms a column of its own.
    const maxPts = cols * 2 + 2;
    if (n <= maxPts) return pts;

    const span = xEnd - xStart;
    const ts   = new Float64Array(maxPts);
    const val  = new Float64Array(maxPts);
    const sign = pts.sign ? new Int8Array(maxPts) : null;
    let k = 0;

    let i = 0;
    while (i < n) {
      // Advance j to the end of the pixel column that pts[i] falls in.
      const col = Math.floor((pts.ts[i] - xStart) / span * cols);
      let j = i;
      let lo = i, hi = i;
      while (j < n && Math.floor((pts.ts[j] - xStart) / span * cols) === col) {
        if (pts.val[j] < pts.val[lo]) lo = j;
        if (pts.val[j] > pts.val[hi]) hi = j;
        j++;
      }
      // Emit min and max in the order they occur, so the trace stays monotonic in ts.
      const a = Math.min(lo, hi), b = Math.max(lo, hi);
      ts[k] = pts.ts[a]; val[k] = pts.val[a]; if (sign) sign[k] = pts.sign[a]; k++;
      if (b !== a && k < maxPts) {
        ts[k] = pts.ts[b]; val[k] = pts.val[b]; if (sign) sign[k] = pts.sign[b]; k++;
      }
      if (k >= maxPts) break;
      i = j;
    }

    const out = { ts: ts.subarray(0, k), val: val.subarray(0, k), length: k };
    if (sign) out.sign = sign.subarray(0, k);
    return out;
  }

  // Returns a "nice" scale: step size, nice min, nice max
  function niceScale(dataMin, dataMax, targetTicks) {
    const range = dataMax - dataMin;
    if (range === 0) return { step: 1, niceMin: dataMin - 1, niceMax: dataMax + 1 };
    const roughStep = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const norm = roughStep / mag;
    const step = norm < 1.5 ? mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
    const niceMin = Math.floor(dataMin / step) * step;
    const niceMax = Math.ceil(dataMax  / step) * step;
    return { step, niceMin, niceMax };
  }

  function formatTick(v, step) {
    const dp = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
    return v.toFixed(dp);
  }

  return { init, render, updateCursor };
})();
