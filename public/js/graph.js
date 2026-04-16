// Graph tab — time-series canvas renderer
const Graph = (() => {

  const BG    = '#0f1923';
  const GRID  = '#1e3248';
  const LABEL = '#7fb3cc';
  const TITLE = '#c8e6f5';
  const GAP   = 8; // px between sub-plot bands
  const M     = { top: 12, right: 24, bottom: 40, left: 58 };

  // X-axis tick intervals in seconds
  const X_INTERVALS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

  let canvas = null;
  let offscreen = null; // stored base image (no cursor)
  let _lastData = null;

  function init() {
    canvas = document.getElementById('graph-canvas');
    new ResizeObserver(() => {
      if (_lastData) render(_lastData);
    }).observe(canvas);
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
    if (data.series.length > 0) drawCursor(ctx, W, H, data.currentTs, data.trimStart, data.trimEnd, dpr);
  }

  function updateCursor(ts) {
    if (!_lastData || !offscreen || !canvas.offsetWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(offscreen, 0, 0);
    if (_lastData.series.length > 0) drawCursor(ctx, W, H, ts, _lastData.trimStart, _lastData.trimEnd, dpr);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────

  function drawBase(ctx, W, H, data) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const { series, trimStart, trimEnd } = data;

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

    // X helpers
    const xSpan = trimEnd - trimStart; // ms
    const toX = ts => M.left + (ts - trimStart) / xSpan * plotW;

    // Draw each band
    series.forEach((s, i) => {
      const bandTop = M.top + i * (bandH + GAP);
      drawBand(ctx, s, bandTop, bandH, plotW, toX, W);
    });

    // Shared x-axis at bottom of last band
    const lastBandBottom = M.top + (n - 1) * (bandH + GAP) + bandH;
    drawXAxis(ctx, W, lastBandBottom, plotW, trimStart, trimEnd, toX);
  }

  function drawBand(ctx, s, bandTop, bandH, plotW, toX, W) {
    const allVals = s.boats.flatMap(b => b.points.map(p => p.val));
    if (allVals.length === 0) return;

    let yMin = Math.min(...allVals);
    let yMax = Math.max(...allVals);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;

    const toY = v => bandTop + (1 - (v - yMin) / (yMax - yMin)) * bandH;

    // Grid lines + y-axis ticks
    const { step, niceMin, niceMax } = niceScale(yMin, yMax, 5);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = LABEL;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let v = niceMin; v <= niceMax + step * 0.01; v += step) {
      if (v < yMin || v > yMax) continue;
      const py = toY(v);
      ctx.beginPath();
      ctx.moveTo(M.left, py);
      ctx.lineTo(M.left + plotW, py);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(formatTick(v, step), M.left - 5, py);
    }

    // Y-axis label (variable name + unit)
    const label = s.unit ? `${s.varName} (${s.unit})` : s.varName;
    ctx.save();
    ctx.fillStyle = TITLE;
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
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const { ts, val } of b.points) {
        const px = toX(ts);
        const py = toY(val);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
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
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(legendX - textW - 8, legendY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      // value
      ctx.fillStyle = TITLE;
      ctx.textAlign = 'right';
      ctx.fillText(txt, legendX, legendY);
      legendY += 15;
    });
  }

  function drawXAxis(ctx, W, axisY, plotW, trimStart, trimEnd, toX) {
    const xSpanS = (trimEnd - trimStart) / 1000;

    // Pick tick interval: aim for ~6 ticks
    let interval = X_INTERVALS_S[X_INTERVALS_S.length - 1];
    for (const s of X_INTERVALS_S) {
      if (xSpanS / s <= 7) { interval = s; break; }
    }

    // Bottom axis line
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, axisY);
    ctx.lineTo(M.left + plotW, axisY);
    ctx.stroke();

    // Ticks
    const firstTick = Math.ceil(trimStart / 1000 / interval) * interval * 1000;
    ctx.fillStyle = LABEL;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let ts = firstTick; ts <= trimEnd; ts += interval * 1000) {
      const px = toX(ts);
      const d = new Date(ts);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const label = interval < 60 ? `${hh}:${mm}:${String(d.getUTCSeconds()).padStart(2, '0')}` : `${hh}:${mm}`;
      ctx.beginPath();
      ctx.moveTo(px, axisY);
      ctx.lineTo(px, axisY + 4);
      ctx.stroke();
      ctx.fillText(label, px, axisY + 6);
    }

    // Axis title
    ctx.fillStyle = TITLE;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Time (UTC)', M.left + plotW / 2, axisY + 30);
  }

  function drawCursor(ctx, W, H, ts, trimStart, trimEnd, dpr) {
    if (ts < trimStart || ts > trimEnd) return;
    const plotW = W - M.left - M.right;
    const plotH = H - M.top  - M.bottom;
    const px = M.left + (ts - trimStart) / (trimEnd - trimStart) * plotW;

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
