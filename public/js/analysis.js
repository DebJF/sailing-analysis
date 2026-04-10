// Canvas-based scatter plot renderer for upwind analysis
const Analysis = (() => {
  let canvas, ctx;

  const MARGIN = { top: 28, right: 28, bottom: 56, left: 64 };
  const BG     = '#0f1923';
  const GRID   = '#1e3248';
  const AXIS   = '#243d52';
  const LABEL  = '#7fb3cc';
  const TITLE  = '#c8e6f5';

  function init() {
    canvas = document.getElementById('scatter-canvas');
    ctx    = canvas.getContext('2d');
    // Redraw on resize
    new ResizeObserver(() => { if (canvas._lastPoints) render(canvas._lastPoints); }).observe(canvas);
  }

  function render(points) {
    canvas._lastPoints = points;
    if (!canvas.offsetWidth) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.offsetWidth;
    const H   = canvas.offsetHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const M     = MARGIN;
    const plotW = W - M.left - M.right;
    const plotH = H - M.top  - M.bottom;

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    if (points.length === 0) {
      ctx.fillStyle = LABEL;
      ctx.font      = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No upwind data — upload a log file first', W / 2, H / 2);
      return;
    }

    // Axes range — TWA is folded to positive (abs) so port/stbd overlap for comparison
    const xMin = 0, xMax = 56;
    const rawMax = Math.max(...points.map(p => p.bsp));
    const yStep  = rawMax <= 8 ? 1 : rawMax <= 16 ? 2 : 5;
    const yMax   = Math.ceil(rawMax / yStep) * yStep;

    function toX(twa) { return M.left + (Math.abs(twa) / xMax) * plotW; }
    function toY(bsp) { return M.top  + (1 - bsp / yMax) * plotH; }

    // --- Grid ---
    ctx.strokeStyle = GRID;
    ctx.lineWidth   = 1;

    for (let x = 10; x <= 50; x += 10) {
      const px = toX(x);
      ctx.beginPath(); ctx.moveTo(px, M.top); ctx.lineTo(px, M.top + plotH); ctx.stroke();
    }
    for (let y = 0; y <= yMax; y += yStep) {
      const py = toY(y);
      ctx.beginPath(); ctx.moveTo(M.left, py); ctx.lineTo(M.left + plotW, py); ctx.stroke();
    }

    // --- Data points ---
    for (const pt of points) {
      ctx.fillStyle   = pt.color;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(toX(pt.twa), toY(pt.bsp), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // --- Axes ---
    ctx.strokeStyle = LABEL;
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(M.left, M.top); ctx.lineTo(M.left, M.top + plotH);
    ctx.lineTo(M.left + plotW, M.top + plotH); ctx.stroke();

    // --- Tick labels ---
    ctx.fillStyle = LABEL;
    ctx.font      = '11px system-ui, sans-serif';

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let x = 0; x <= 50; x += 10) {
      ctx.fillText(x + '°', toX(x), M.top + plotH + 6);
    }

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let y = 0; y <= yMax; y += yStep) {
      ctx.fillText(y.toFixed(0), M.left - 8, toY(y));
    }

    // --- Axis titles ---
    ctx.fillStyle    = TITLE;
    ctx.font         = '12px system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('True Wind Angle (°)', M.left + plotW / 2, H - 10);

    ctx.save();
    ctx.translate(14, M.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Boat Speed (kts)', 0, 0);
    ctx.restore();

    // --- Legend ---
    const lx = M.left + plotW - 4, ly = M.top + 8;
    _legendDot(lx - 90, ly, '#43a047', 'Starboard');
    _legendDot(lx - 14, ly, '#e53935', 'Port');
  }

  function _legendDot(x, y, color, label) {
    ctx.fillStyle    = color;
    ctx.globalAlpha  = 0.85;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha  = 1;
    ctx.fillStyle    = LABEL;
    ctx.font         = '11px system-ui, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 8, y);
  }

  return { init, render };
})();
