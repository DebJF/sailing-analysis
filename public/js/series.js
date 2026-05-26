// Compact typed-array time-series. A "Series" is the shape
//   { ts: Float64Array, val: Float64Array, length: number }
const Series = (() => {

  const EMPTY = { ts: new Float64Array(0), val: new Float64Array(0), length: 0 };

  function make(n) {
    return { ts: new Float64Array(n), val: new Float64Array(n), length: n };
  }

  function empty() { return EMPTY; }

  // Merge two sorted-by-ts series into a fresh, owned series. O(n+m).
  function merge(a, b) {
    const n = a.length + b.length;
    const ts = new Float64Array(n);
    const val = new Float64Array(n);
    let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) {
      if (a.ts[i] <= b.ts[j]) { ts[k] = a.ts[i]; val[k] = a.val[i]; i++; }
      else                    { ts[k] = b.ts[j]; val[k] = b.val[j]; j++; }
      k++;
    }
    while (i < a.length) { ts[k] = a.ts[i]; val[k] = a.val[i]; i++; k++; }
    while (j < b.length) { ts[k] = b.ts[j]; val[k] = b.val[j]; j++; k++; }
    return { ts, val, length: n };
  }

  // Two arrays of {ts,...} row objects, each sorted by ts.
  function mergeRows(a, b) {
    const out = new Array(a.length + b.length);
    let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) {
      if (a[i].ts <= b[j].ts) out[k++] = a[i++];
      else                    out[k++] = b[j++];
    }
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out;
  }

  // Carry-forward lookup (last known val at-or-before `ts`). Returns null
  // if ts is before the first sample.
  function carryForward(s, ts) {
    const n = s.length;
    if (n === 0 || ts < s.ts[0]) return null;
    if (ts >= s.ts[n - 1]) return s.val[n - 1];
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (s.ts[mid] <= ts) lo = mid; else hi = mid;
    }
    return s.val[lo];
  }

  // Zero-copy view-slice for ts in [fromTs, toTs]. The returned ts/val are
  // subarray views on the source buffer — safe for read-only use.
  function sliceByTs(s, fromTs, toTs) {
    const tsArr = s.ts, n = s.length;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tsArr[m] < fromTs) lo = m + 1; else hi = m; }
    const start = lo;
    hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tsArr[m] <= toTs) lo = m + 1; else hi = m; }
    return {
      ts:     s.ts.subarray(start, lo),
      val:    s.val.subarray(start, lo),
      length: lo - start,
    };
  }

  // Allocate a fresh owned series from a view-slice (so mutations / outliving
  // the parent buffer are safe).
  function copy(s) {
    return {
      ts:     new Float64Array(s.ts),
      val:    new Float64Array(s.val),
      length: s.length,
    };
  }

  // Filter a series. `predicate(ts, val, i)` → boolean. Single pass: stages
  // matches in plain arrays then copies into right-sized Float64Arrays. The
  // predicate is invoked once per input element (vs the obvious two-pass
  // count-then-fill approach), which matters when the predicate is a closure
  // over an outer scan (e.g. tack-interval membership).
  function filter(s, predicate) {
    const tsBuf = [];
    const valBuf = [];
    for (let i = 0; i < s.length; i++) {
      const ts = s.ts[i], val = s.val[i];
      if (predicate(ts, val, i)) { tsBuf.push(ts); valBuf.push(val); }
    }
    return {
      ts:     Float64Array.from(tsBuf),
      val:    Float64Array.from(valBuf),
      length: tsBuf.length,
    };
  }

  // Circular mean + range for an angle series (degrees). Returns
  // { mean: 0..360 or null, range: deg }. Handles wraparound.
  function circularStats(s) {
    if (!s.length) return { mean: null, range: 0 };
    let sinSum = 0, cosSum = 0;
    for (let i = 0; i < s.length; i++) {
      const r = s.val[i] * Math.PI / 180;
      sinSum += Math.sin(r);
      cosSum += Math.cos(r);
    }
    const mean = ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
    let minDev = Infinity, maxDev = -Infinity;
    for (let i = 0; i < s.length; i++) {
      let d = s.val[i] - mean;
      if (d >  180) d -= 360;
      if (d < -180) d += 360;
      if (d < minDev) minDev = d;
      if (d > maxDev) maxDev = d;
    }
    return { mean, range: maxDev - minDev };
  }

  return { make, empty, merge, mergeRows, carryForward, sliceByTs, copy, filter, circularStats };
})();
