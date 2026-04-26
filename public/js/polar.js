// Expedition .pol polar file parser, interpolation, and serialiser
const Polar = (() => {

  // Standard TWA ticks in an Expedition polar. Any TWA in an upwind/downwind
  // angular range that is not in this set is treated as a VMG-optimal entry.
  const STANDARD_TWAS = new Set([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180]);

  function parsePol(text) {
    const lines = text.split(/\r?\n/);
    const header = [];
    const rows = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('!')) { header.push(line); continue; }

      // Expedition polars are whitespace-separated (usually tabs).
      const tokens = line.split(/\s+/).map(parseFloat).filter(n => !isNaN(n));
      if (tokens.length < 3 || (tokens.length - 1) % 2 !== 0) continue;

      const tws = tokens[0];
      const points = [];
      for (let i = 1; i < tokens.length; i += 2) {
        points.push({ twa: tokens[i], bsp: tokens[i + 1] });
      }
      points.sort((a, b) => a.twa - b.twa);

      // Detect VMG-optimal angles: TWAs in the upwind (30..90) or downwind
      // (90..170) arcs that aren't on a standard 10° tick. Tie-breaker if
      // multiple non-standard entries appear in the same arc: take the one
      // with the highest |VMG| = bsp·|cos(TWA)|.
      let upwind = null, downwind = null;
      let upwindVmg = -Infinity, downwindVmg = -Infinity;
      for (const p of points) {
        if (p.twa < 30 || p.twa > 170) continue;
        if (STANDARD_TWAS.has(p.twa)) continue;
        const vmg = p.bsp * Math.abs(Math.cos(p.twa * Math.PI / 180));
        if (p.twa < 90) {
          if (vmg > upwindVmg) { upwindVmg = vmg; upwind = p; }
        } else if (p.twa > 90) {
          if (vmg > downwindVmg) { downwindVmg = vmg; downwind = p; }
        }
      }

      rows.push({ tws, points, upwind, downwind });
    }

    rows.sort((a, b) => a.tws - b.tws);
    const twsGrid = rows.map(r => r.tws);

    const twaSet = new Set();
    for (const r of rows) for (const p of r.points) twaSet.add(p.twa);
    const allTwas = [...twaSet].sort((a, b) => a - b);

    return { header, rows, twsGrid, allTwas };
  }

  function interp1d(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + t * (ys[hi] - ys[lo]);
  }

  function bspAtTwa(row, twa) {
    const xs = row.points.map(p => p.twa);
    const ys = row.points.map(p => p.bsp);
    return interp1d(xs, ys, twa);
  }

  // Bilinear interpolation across the TWS/TWA grid. TWA is folded to |TWA|
  // since the polar is symmetric port/starboard.
  function lookupBsp(polar, tws, twa) {
    const rows = polar.rows;
    if (rows.length === 0) return null;
    const absTwa = Math.abs(twa);

    if (tws <= rows[0].tws) return bspAtTwa(rows[0], absTwa);
    if (tws >= rows[rows.length - 1].tws) return bspAtTwa(rows[rows.length - 1], absTwa);

    let lo = 0, hi = rows.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].tws <= tws) lo = mid; else hi = mid;
    }
    const t = (tws - rows[lo].tws) / (rows[hi].tws - rows[lo].tws);
    const b1 = bspAtTwa(rows[lo], absTwa);
    const b2 = bspAtTwa(rows[hi], absTwa);
    return b1 + t * (b2 - b1);
  }

  function serialisePol(polar) {
    const lines = [...polar.header];
    for (const r of polar.rows) {
      const parts = [r.tws.toFixed(1)];
      for (const p of r.points) {
        parts.push(p.twa.toFixed(1));
        parts.push(p.bsp.toFixed(2));
      }
      lines.push(parts.join('\t'));
    }
    return lines.join('\n');
  }

  return { parsePol, lookupBsp, serialisePol, STANDARD_TWAS };
})();
