// Stage 2: quality-filtered sample pipeline. Pure math — no DOM, no globals.
// Given a log's raw series and the user's thresholds, returns 60 s averaged
// samples that are safe to use for polar refinement.
const PolarRefine = (() => {

  const DEFAULTS = {
    stride:           10000,  // ms between sample centres
    window:           60000,  // ms averaging window (centred on stride ts)
    manoeuvreBefore:  10000,  // ms — how far before a tack/gybe to start excluding
    manoeuvreAfter:   50000,  // ms — how far after
    deltaTws:             4,  // kn — max TWS range across window
    deltaTwd:            15,  // deg — max TWD range across window (circular)
    hdgSwing:            30,  // deg — max HDG range across window (circular)
    minBsp:               2,  // kn — drop drift/sail-change periods
  };

  function sliceByTs(series, fromTs, toTs) {
    let lo = 0, hi = series.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].ts < fromTs) lo = m + 1; else hi = m; }
    const start = lo;
    hi = series.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].ts <= toTs) lo = m + 1; else hi = m; }
    return series.slice(start, lo);
  }

  function meanOf(slice) {
    if (!slice.length) return null;
    let s = 0;
    for (const p of slice) s += p.val;
    return s / slice.length;
  }

  function rangeOf(slice) {
    if (!slice.length) return 0;
    let mn = slice[0].val, mx = slice[0].val;
    for (const p of slice) { if (p.val < mn) mn = p.val; if (p.val > mx) mx = p.val; }
    return mx - mn;
  }

  // Circular mean/range for angles (0..360 or -180..180). Handles wraparound.
  function circularStats(slice) {
    if (!slice.length) return { mean: null, range: 0 };
    let sinSum = 0, cosSum = 0;
    for (const p of slice) {
      sinSum += Math.sin(p.val * Math.PI / 180);
      cosSum += Math.cos(p.val * Math.PI / 180);
    }
    const mean = ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
    let minDev = Infinity, maxDev = -Infinity;
    for (const p of slice) {
      let d = p.val - mean;
      if (d >  180) d -= 360;
      if (d < -180) d += 360;
      if (d < minDev) minDev = d;
      if (d > maxDev) maxDev = d;
    }
    return { mean, range: maxDev - minDev };
  }

  // Merge and widen manoeuvre intervals. Intervals passed in as [start,end]
  // pairs in ms (typically a tack/gybe is a point event; widening adds the
  // user-chosen before/after buffer).
  function buildManoeuvreMask(tackTimestamps, gybeTimestamps, before, after) {
    const raw = [];
    for (const ts of tackTimestamps) raw.push([ts - before, ts + after]);
    for (const ts of gybeTimestamps) raw.push([ts - before, ts + after]);
    raw.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of raw) {
      if (merged.length && merged[merged.length - 1][1] >= iv[0]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
      } else {
        merged.push([iv[0], iv[1]]);
      }
    }
    return merged;
  }

  // Does any interval in mask overlap [from,to]? mask must be sorted by start.
  function maskHits(mask, from, to) {
    // Binary search for first interval whose end >= from
    let lo = 0, hi = mask.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (mask[m][1] < from) lo = m + 1; else hi = m; }
    return lo < mask.length && mask[lo][0] <= to;
  }

  /**
   * @param {object} data
   *   data.tws,twa,bsp: array of {ts,val} — required
   *   data.twd,hdg:     array of {ts,val} — optional (stability checks skipped if null)
   *   data.tackTs:      array of ms timestamps (point events)
   *   data.gybeTs:      array of ms timestamps
   *   data.qualityStart,qualityEnd: ms window for this log
   * @param {object} params  overrides on DEFAULTS
   * @returns { samples, rejected: { manoeuvre, wind, hdg, bsp, missing }, strideCount }
   */
  function generateSamples(data, params = {}) {
    const p = { ...DEFAULTS, ...params };
    const halfW = p.window / 2;

    const mask = buildManoeuvreMask(
      data.tackTs || [],
      data.gybeTs || [],
      p.manoeuvreBefore,
      p.manoeuvreAfter,
    );

    const samples = [];
    const rejected = { manoeuvre: 0, wind: 0, hdg: 0, bsp: 0, missing: 0 };
    let strideCount = 0;

    const start = data.qualityStart + halfW;
    const end   = data.qualityEnd   - halfW;

    for (let ts = start; ts <= end; ts += p.stride) {
      strideCount++;
      const from = ts - halfW, to = ts + halfW;

      if (maskHits(mask, from, to)) { rejected.manoeuvre++; continue; }

      const twsSlice = sliceByTs(data.tws, from, to);
      const twaSlice = sliceByTs(data.twa, from, to);
      const bspSlice = sliceByTs(data.bsp, from, to);
      if (!twsSlice.length || !twaSlice.length || !bspSlice.length) { rejected.missing++; continue; }

      if (rangeOf(twsSlice) > p.deltaTws) { rejected.wind++; continue; }
      if (data.twd) {
        const twdSlice = sliceByTs(data.twd, from, to);
        if (twdSlice.length && circularStats(twdSlice).range > p.deltaTwd) { rejected.wind++; continue; }
      }
      if (data.hdg) {
        const hdgSlice = sliceByTs(data.hdg, from, to);
        if (hdgSlice.length && circularStats(hdgSlice).range > p.hdgSwing) { rejected.hdg++; continue; }
      }

      const bspMean = meanOf(bspSlice);
      if (bspMean < p.minBsp) { rejected.bsp++; continue; }

      // TWA stays on one tack inside a manoeuvre-free window, so arithmetic
      // mean is accurate; fold to |TWA| for the symmetric polar.
      const twaMean = meanOf(twaSlice);
      const twsMean = meanOf(twsSlice);
      samples.push({
        ts,
        tws: twsMean,
        twa: Math.abs(twaMean),
        bsp: bspMean,
      });
    }

    return { samples, rejected, strideCount };
  }

  // ── Stage 3: per-cell recommendation ──────────────────────────────────────

  const RECOMMEND_DEFAULTS = {
    percentile:    75,    // 50..90 — chosen percentile of (observed/polar) ratios
    minSamples:    10,    // ≥ this many samples in a cell to recommend a change
    minSpanSec:   600,    // AND samples must span at least this many seconds
  };

  // Linear-interpolated quantile (q in [0,1]). quantileSorted assumes the
  // input is already sorted ascending — caller must sort beforehand.
  function quantileSorted(sorted, q) {
    if (!sorted.length) return null;
    const idx = q * (sorted.length - 1);
    const lo  = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function quantile(values, q) {
    if (!values.length) return null;
    return quantileSorted([...values].sort((a, b) => a - b), q);
  }

  // The upwind optimal angle for a given TWS (linearly interpolated across rows).
  // Used to exclude no-go-zone samples from refinement: an Expedition polar
  // typically encodes the no-go zone with BSP = 0 at standard ticks (e.g. 0/20/30°),
  // and lookupBsp linearly interpolates between (30°, 0) and (44°, 6.02), which
  // gives an unrealistically low denominator for samples sailed at e.g. 42° —
  // those samples then appear faster than polar and inflate the optimal cell.
  // For rows without an explicit upwind entry, fall back to the smallest TWA
  // whose BSP > 0.
  function upwindCutoffTwa(polar, tws) {
    const rows = polar.rows;
    if (!rows.length) return 0;

    const rowCutoff = (row) => {
      if (row.upwind) return row.upwind.twa;
      for (const p of row.points) if (p.bsp > 0.01) return p.twa;
      return 0;
    };

    if (tws <= rows[0].tws) return rowCutoff(rows[0]);
    if (tws >= rows[rows.length - 1].tws) return rowCutoff(rows[rows.length - 1]);

    let lo = 0, hi = rows.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].tws <= tws) lo = mid; else hi = mid;
    }
    const t = (tws - rows[lo].tws) / (rows[hi].tws - rows[lo].tws);
    return rowCutoff(rows[lo]) + t * (rowCutoff(rows[hi]) - rowCutoff(rows[lo]));
  }

  // Find the (twsIdx, pointIdx) of the polar cell closest to a sample.
  // Distance metric weights TWA differences against TWS differences so 5° ≈ 1 kn,
  // matching the typical polar grid spacing.
  function nearestCell(polar, tws, twa) {
    const rows = polar.rows;
    if (!rows.length) return null;
    const absTwa = Math.abs(twa);

    let bestTws = 0, bestTwsDist = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(rows[i].tws - tws);
      if (d < bestTwsDist) { bestTwsDist = d; bestTws = i; }
    }

    const points = rows[bestTws].points;
    let bestPt = 0, bestPtDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].twa - absTwa);
      if (d < bestPtDist) { bestPtDist = d; bestPt = i; }
    }

    return { twsIdx: bestTws, pointIdx: bestPt };
  }

  // Apply one optimum shift (upwind or downwind) to a refined-polar row.
  // - explicit polar optimum: removes the old marker entry and inserts new
  // - implicit polar optimum (= a standard tick that happens to be max-VMG):
  //   keeps the standard tick in place and inserts the new optimum alongside
  // No-op if the observed optimum is missing, has too few samples, or differs
  // by less than minShiftDeg from the polar's optimum.
  function _applyOptimumShift(row, side, observed, polarOpt, params) {
    if (!observed || !polarOpt) return;
    if (polarOpt.bsp <= 0.01) return;       // can't compute deltaPct from a zero baseline
    if (observed.totalCount < params.minSamples) return;
    const shift = observed.observedTwa - polarOpt.twa;
    if (Math.abs(shift) < params.minShiftDeg) return;

    const oldTwa = polarOpt.twa;
    const oldBsp = polarOpt.bsp;
    const newTwa = observed.observedTwa;
    const newBsp = observed.observedBsp;
    const isImplicit = !!polarOpt.isImplicit;

    if (!isImplicit) {
      const oldIdx = row.points.findIndex(pp => Math.abs(pp.twa - oldTwa) < 0.01);
      if (oldIdx >= 0) row.points.splice(oldIdx, 1);
    }

    const existIdx = row.points.findIndex(pp => Math.abs(pp.twa - newTwa) < 0.01);
    const pointData = {
      twa:         newTwa,
      bsp:         newBsp,
      bspOld:      oldBsp,
      twaOld:      oldTwa,
      // Identity for manual-override matching: explicit shifts inherit the
      // original optimum's TWA; implicit shifts are new entries so use their
      // own TWA so they don't clash with the kept-in-place standard tick.
      originalTwa: isImplicit ? newTwa : oldTwa,
      sampleCount: observed.totalCount,
      recommended: true,
      shifted:     true,
      deltaPct:    ((newBsp - oldBsp) / oldBsp) * 100,
    };
    if (existIdx >= 0) row.points[existIdx] = pointData;
    else               row.points.push(pointData);
    row.points.sort((a, b) => a.twa - b.twa);
    row[side] = row.points.find(pp => Math.abs(pp.twa - newTwa) < 0.01);
  }

  // Compute a refined polar from samples. Cells with insufficient data keep
  // their original BSP (recommended: false). Cells with enough samples get
  // bsp = old × percentileRatio (recommended: true).
  //
  // Returns a polar-shaped object compatible with Polar.serialisePol(); each
  // point carries bspOld + recommendation metadata for display.
  function recommend(samples, polar, params = {}) {
    const p = { ...RECOMMEND_DEFAULTS, ...params };
    if (!polar || !polar.rows.length) return null;

    // Bin samples by nearest cell. Two ways a sample can be excluded:
    //   1. lookup BSP is 0 (sample at TWA below first non-zero polar tick) —
    //      ratio undefined.
    //   2. Sample TWA is below the upwind optimal angle for that TWS (the
    //      no-go zone). The polar's interpolated BSP there is meaningless;
    //      samples there will be addressed by Stage 4's optimal-angle detection.
    const bins = new Map();   // key "twsIdx:pointIdx" → { ratios, timestamps }
    let excludedNoGo = 0;
    for (const s of samples) {
      if (s.twa < upwindCutoffTwa(polar, s.tws)) { excludedNoGo++; continue; }
      const polarBsp = Polar.lookupBsp(polar, s.tws, s.twa);
      if (polarBsp === null || polarBsp <= 0.01) continue;
      const cell = nearestCell(polar, s.tws, s.twa);
      if (!cell) continue;
      const polarPt = polar.rows[cell.twsIdx].points[cell.pointIdx];
      if (!polarPt || polarPt.bsp <= 0.01) continue;  // never recommend across the no-go boundary
      const key = `${cell.twsIdx}:${cell.pointIdx}`;
      let bin = bins.get(key);
      if (!bin) { bin = { ratios: [], timestamps: [] }; bins.set(key, bin); }
      bin.ratios.push(s.bsp / polarBsp);
      bin.timestamps.push(s.ts);
    }

    // Every refined-polar point carries `originalTwa` — its stable identity
    // (= the TWA the point had in the user's original polar). This lets manual
    // drag-edits be keyed reliably across recomputations even after Stage 4
    // shifts move a point's `twa`.
    const newRows = polar.rows.map((row, twsIdx) => ({
      tws: row.tws,
      upwind: row.upwind,
      downwind: row.downwind,
      points: row.points.map((pt, pointIdx) => {
        const bin = bins.get(`${twsIdx}:${pointIdx}`);
        const sampleCount = bin ? bin.ratios.length : 0;
        const base = { twa: pt.twa, bsp: pt.bsp, bspOld: pt.bsp, originalTwa: pt.twa, sampleCount };
        if (!bin || pt.bsp <= 0.01) { base.recommended = false; return base; }
        const minTs = Math.min(...bin.timestamps);
        const maxTs = Math.max(...bin.timestamps);
        base.timeSpanSec = (maxTs - minTs) / 1000;
        const enough = sampleCount >= p.minSamples && base.timeSpanSec >= p.minSpanSec;
        if (!enough) { base.recommended = false; return base; }
        const factor   = quantile(bin.ratios, p.percentile / 100);
        const newBsp   = pt.bsp * factor;
        base.bsp         = newBsp;
        base.factor      = factor;
        base.deltaPct    = (newBsp - pt.bsp) / pt.bsp * 100;
        base.recommended = true;
        return base;
      }),
    }));

    // Stage 4 integration: where the observed upwind/downwind optimum has
    // moved by ≥ minShiftDeg, fold that into the refined polar. For an
    // explicit polar optimum (e.g. 44° marker entry) the old TWA is removed
    // and replaced. For an implicit one (e.g. TWS=10 where the optimum
    // coincides with the 40° standard tick) the standard tick stays in place
    // and a new optimum entry is inserted; the row's upwind/downwind ref
    // moves to the new entry. Same logic on both sides.
    const optima = detectOptimalAngles(samples, polar, p);
    for (const opt of optima) {
      _applyOptimumShift(newRows[opt.twsIdx], 'upwind',   opt.upwind,   opt.polarUpwind,   p);
      _applyOptimumShift(newRows[opt.twsIdx], 'downwind', opt.downwind, opt.polarDownwind, p);
    }

    // Rebuild allTwas — Stage 4 may have introduced TWAs absent from the
    // original polar (e.g. observed optimum at 41° when polar had 44°).
    const twaSet = new Set();
    for (const r of newRows) for (const pp of r.points) twaSet.add(pp.twa);
    const allTwas = [...twaSet].sort((a, b) => a - b);

    return {
      header: polar.header,
      rows: newRows,
      twsGrid: polar.twsGrid,
      allTwas,
      excludedNoGo,
      optima,
    };
  }

  // ── Stage 4: observed optimal upwind / downwind angles ───────────────────

  const OPTIMAL_DEFAULTS = {
    twsBand:        0.5,    // ±kn around each polar TWS row
    upwindLo:        30,    // TWA degrees — upwind sector to scan
    upwindHi:        80,
    downwindLo:     100,    // downwind sector
    downwindHi:     175,
    minBinSamples:    3,    // per 1° TWA bin
    minShiftDeg:      1,    // only flag/apply a change if shift ≥ this
  };

  // Highest-|VMG| point in a polar row inside [twaLo, twaHi]. Returns
  // {twa, bsp} or null if the sector has no usable point.
  function _maxVmgPoint(row, twaLo, twaHi) {
    let bestTwa = null, bestBsp = null, bestVmg = -Infinity;
    for (const p of row.points) {
      if (p.bsp <= 0.01) continue;
      if (p.twa < twaLo || p.twa > twaHi) continue;
      const vmg = p.bsp * Math.abs(Math.cos(p.twa * Math.PI / 180));
      if (vmg > bestVmg) { bestVmg = vmg; bestTwa = p.twa; bestBsp = p.bsp; }
    }
    return bestTwa === null ? null : { twa: bestTwa, bsp: bestBsp };
  }

  // Effective up/downwind for a polar row: the explicit row.upwind/downwind
  // if present, otherwise the highest-|VMG| point in the relevant sector
  // (e.g. 40° for a TWS row whose first non-zero entry is the optimum).
  // Returns {twa, bsp, isImplicit} or null.
  function _effectiveUpwind(row) {
    if (row.upwind) return { twa: row.upwind.twa, bsp: row.upwind.bsp, isImplicit: false };
    const m = _maxVmgPoint(row, OPTIMAL_DEFAULTS.upwindLo, OPTIMAL_DEFAULTS.upwindHi);
    return m ? { twa: m.twa, bsp: m.bsp, isImplicit: true } : null;
  }

  function _effectiveDownwind(row) {
    if (row.downwind) return { twa: row.downwind.twa, bsp: row.downwind.bsp, isImplicit: false };
    const m = _maxVmgPoint(row, OPTIMAL_DEFAULTS.downwindLo, OPTIMAL_DEFAULTS.downwindHi);
    return m ? { twa: m.twa, bsp: m.bsp, isImplicit: true } : null;
  }

  // Argmax of percentile VMG across 1° TWA bins inside [twaLo,twaHi].
  // Uses |cos(TWA)| so the same code works for both upwind (positive cos) and
  // downwind (negative cos — argmax of |cos| = argmax of |VMG| in that sector).
  function _findOptimum(sectorSamples, twaLo, twaHi, p) {
    const sector = sectorSamples.filter(s => s.twa >= twaLo && s.twa <= twaHi);
    if (sector.length === 0) return null;

    const bins = new Map();
    for (const s of sector) {
      const t = Math.round(s.twa);
      let arr = bins.get(t);
      if (!arr) { arr = []; bins.set(t, arr); }
      arr.push(s);
    }

    // We sort vmgs and bsps in place once and call quantileSorted, avoiding
    // the spread-and-sort that quantile() does internally.
    const binStats = [];
    const q = p.percentile / 100;
    for (const [twa, slice] of bins) {
      if (slice.length < p.minBinSamples) continue;
      const vmgs = slice.map(s => s.bsp * Math.abs(Math.cos(s.twa * Math.PI / 180)));
      const bsps = slice.map(s => s.bsp);
      vmgs.sort((a, b) => a - b);
      bsps.sort((a, b) => a - b);
      binStats.push({
        twa,
        vmg:   quantileSorted(vmgs, q),
        bsp:   quantileSorted(bsps, q),
        count: slice.length,
      });
    }
    if (!binStats.length) return null;

    let best = binStats[0];
    for (const b of binStats) if (b.vmg > best.vmg) best = b;

    return {
      observedTwa:  best.twa,
      observedBsp:  best.bsp,
      observedVmg:  best.vmg,
      bestBinCount: best.count,
      totalCount:   sector.length,
      binCount:     binStats.length,
    };
  }

  // For each TWS row in the polar, return the observed upwind/downwind optima
  // (may be null per side if no data). Caller decides whether to display
  // a 'suggest' marker based on the shift vs the polar's stored optimum.
  function detectOptimalAngles(samples, polar, params = {}) {
    const p = { ...RECOMMEND_DEFAULTS, ...OPTIMAL_DEFAULTS, ...params };
    if (!polar || !polar.rows.length) return [];

    return polar.rows.map((row, twsIdx) => {
      const inBand = samples.filter(s => Math.abs(s.tws - row.tws) <= p.twsBand);
      return {
        twsIdx,
        tws:           row.tws,
        polarUpwind:   _effectiveUpwind(row),
        polarDownwind: _effectiveDownwind(row),
        upwind:        _findOptimum(inBand, p.upwindLo,   p.upwindHi,   p),
        downwind:      _findOptimum(inBand, p.downwindLo, p.downwindHi, p),
        bandSamples:   inBand.length,
      };
    });
  }

  return {
    DEFAULTS, RECOMMEND_DEFAULTS, OPTIMAL_DEFAULTS,
    generateSamples, recommend, detectOptimalAngles,
    sliceByTs, circularStats, quantile, upwindCutoffTwa,
  };
})();
