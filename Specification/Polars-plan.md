# Polar refinement from log data

## Context

You have Expedition `.pol` polar files for the yacht — TWS rows × (TWA, BSP) pairs, with dedicated entries for the upwind- and downwind-VMG optimal angles. The aim is to use high-quality sections of one or more Expedition CSV logs to *suggest* refinements to that polar (not wholesale overwrite it), visualise old vs new as both a table and polar plot, and identify whether the optimal upwind/downwind TWA have shifted. You've explicitly asked for a staged delivery with room to experiment.

## Standalone vs integrated — recommendation

**Build it inside the existing `sailing-analysis` app, as a new "Polars" tab.**

The refinement workflow leans on infrastructure that already exists here:

- `Parser.parse()` (parser.js) — log CSV parsing, spike-filtered GPS, own-boat isolation
- Per-boat `fieldTimeseries` map + `carryForward()` binary-search lookups (app.js:421) — exactly what's needed to sample TWS/TWA/BSP at arbitrary 60 s boundaries
- `detectTacks()` (app.js:581) and `detectGybes()` (app.js:885) — already used to mask tack/gybe windows in Statistics (app.js:1188), reusable to exclude manoeuvre-adjacent data
- `sliceSeriesByTs()`, `avgVmgInWindow()`, `twdWindowStats()` — the exact window/range helpers needed for stability filtering and rolling means
- `Playback` trim controls — one natural way to let the user bracket the good part of each log
- The existing **Upwind Polars** tab is a scatter plot that you've said isn't useful yet — it is the obvious thing to upgrade into this feature rather than leave dead

A standalone app would have to duplicate the parser, trim UI, field lookups, and tack detection. No deployment saving either — the site is a static bundle on Vercel with no build step.

## Approach

### New module: `public/js/polar.js`

Pure data layer, no DOM. Exposes:

- `parsePol(text)` → `{ header, twsGrid, cells: Map<tws, Array<{twa, bsp}>>, upwindByTws: Map<tws, {twa,bsp}>, downwindByTws: Map<tws, {twa,bsp}> }`. Detect optimal-VMG rows either by marker convention in the file or by post-parse scan (the upwind/downwind angles are the ones that fall between standard ticks — confirm against a sample file in Stage 1).
- `lookupBsp(polar, tws, twa)` → bilinear interpolation (TWS × |TWA|), clamped to the grid edges.
- `serialisePol(polar)` → string, preserving header and untouched cells.

### New module: `public/js/polar_refine.js`

Pure logic, testable by staring at intermediate outputs in the console.

**Noise vs instability.** Boat-instrument data is noisy even when the boat and wind are genuinely steady. The strategy below uses the *window mean* as the sample value (noise averages out), and the *window range* as the rejection criterion (instability / trends do not average out — they tell us the window isn't usable). Every threshold below is a user parameter, not a hard-coded value.

**Sample generation per log:**
1. Walk the log at a fixed stride (default 10 s, configurable) through the log's user-selected quality window.
2. Build an averaging window (default 60 s, configurable) centred on each stride point. Keep the sample only if:
   - **Manoeuvre buffer** — no tack or gybe falls in the interval `[ts − 10 s, ts + 50 s]` relative to the stride point (defaults, configurable; matches the existing `TACK_INT_FROM`/`TACK_INT_TO` = −10 000 / +50 000 in app.js:578 already used for ground-lost integration, so we can reuse the same tack-interval list).
   - **Heading-rate** — max |ΔHDG| across the window below a threshold (default 30° total swing / 60 s, configurable). Handles mark roundings and unintended course changes that aren't picked up as TWA sign-changes.
   - **Wind stability** — TWS range across the window ≤ ΔTWS threshold (default 2 kn) AND TWD range ≤ ΔTWD threshold (default 10°). Both are parameters. Reuses the range logic already in `twdWindowStats` (app.js:563).
   - **Sailing check** — mean BSP ≥ minBsp (default 1 kn) to drop drifting / sail-change periods.
3. Emit one sample `{ts, tws:mean, twa:|mean|, bsp:mean, hdg:mean, tack, logName}`.

**Binning & recommendation:**
1. Snap each sample to the nearest `(tws, twa)` polar cell.
2. For each cell, compute `ratio = bsp_observed / lookupBsp(polar, sample.tws, sample.twa)` (the interpolation means we don't punish cells the sample isn't exactly on).
3. Aggregate ratios per cell. Use a chosen percentile (default 75th, slider 50–90) as the adjustment factor — this is the "stretching but achievable" knob.
4. `new_bsp = old_bsp × percentile_ratio`, but only if the bin has ≥ `minSamples` samples (default 10) across ≥ `minSpanSeconds` (default 600 s). Otherwise leave the cell unchanged and mark "insufficient data".
5. Leave adjacent cells interpolated — no attempt at cross-cell smoothing in Stage 3; add it if experiments show jaggy results.

**Optimal-VMG angles (separate pass):**
1. For each TWS band in the polar, gather all valid samples within ±0.5 kn TWS and inside the upwind (TWA 30–55°) or downwind (TWA 130–175°) sector.
2. Bin by TWA at 1° resolution, compute mean `bsp × cos(TWA°)` per bin using the same percentile rule.
3. Argmax of that curve = observed optimal TWA; value at argmax = optimal BSP.
4. Suggest a replacement for the `0 VMG` / `180 VMG` entries when the shift is ≥ a threshold (default 2°) AND sample count passes the same floor.

### UI: new Polars tab replacing the current scatter

**Top bar**
- Load Polar (`.pol`) — separate file input (dispatch by extension from the existing upload button: `.csv` → log, `.pol` → polar).
- Parameter panel (all live-adjustable, re-runs the pipeline in-place):
  - **Adjustment percentile** (default 75, range 50–90)
  - **Averaging window (s)** (default 60)
  - **Stride (s)** (default 10)
  - **Manoeuvre exclusion: before (s) / after (s)** (defaults 10 / 50)
  - **HDG swing threshold (°/window)** (default 30)
  - **ΔTWS threshold (kn)** (default 2)
  - **ΔTWD threshold (°)** (default 10)
  - **Min samples per cell** (default 10), **Min time-span per cell (s)** (default 600)

**Multi-log refinement panel** (addresses your concern that this could be fiddly across multiple log files)

Rather than making you switch between boats/logs and re-set trim each time:

- One table listing every loaded CSV, each row with:
  - Boat colour/name
  - Quality start / end time inputs (pre-populated from `minTs`/`maxTs`, editable as HH:MM:SS like the existing Statistics tab — app.js:99)
  - "Set from current trim" button — one click copies the Map-tab trim window into this row
  - "Use for refinement" checkbox
  - Live sample count and per-log valid-coverage bar (how much of the quality window actually produced samples after filtering) — catches the case where a log's quality window turned out to be mostly masked by instability
- Samples from all enabled logs are merged into a single pool before binning. Each sample remembers its `logName` so the cell-detail view can show per-log contribution.
- This means adding / editing a log's quality window just updates one row and the recommendations refresh — no need to re-upload or re-trim on the Map tab.

**Two panels**

1. **Table** — TWS columns × TWA rows. Each cell shows old BSP, proposed BSP, Δ%, sample count. Colour-code Δ (red < 0, blue > 0, grey no-change). Hover shows distribution mini-histogram.
2. **Polar plot** — canvas, TWA as angle (0° up = no-go), BSP as radius. One curve per TWS in the polar. Existing polar drawn faded, refined polar drawn bright. Toggle to overlay raw 60-s samples as dots (already implemented scatter logic in `analysis.js` can be repurposed here). Highlight upwind/downwind optimal points with markers; if they've shifted, draw both old and new.

### Staged delivery

**Stage 1 — Parse and display the existing polar.** `polar.js`, a file-input path for `.pol`, new tab renders the current polar as table + polar plot. No logs involved. Small, validates parsing and plot geometry.

**Stage 2 — Quality-filtered sample generation.** `polar_refine.js` sample pipeline, per-log trim UI. Overlay averaged samples on the polar plot. Expose the quality thresholds as live controls — this is the **experimental phase**: you tune the filters until the scatter visually matches the polar in windier/cleaner sections.

**Stage 3 — Recommendations.** Binning + percentile → proposed new polar. Side-by-side table with Δ and confidence. Experiment with percentile, min-samples floor. No export yet — decisions visible only in the UI.

**Stage 4 — Optimal VMG angles.** Upwind/downwind best-TWA detection, displayed as markers on the plot and dedicated summary rows in the table.

**Stage 5 — Export.** `serialisePol` → downloadable `.pol` with user's accepted changes; checkboxes per cell to accept/reject each suggestion.

## Files to create / modify

- NEW: `public/js/polar.js` — parser, interpolation, serialiser
- NEW: `public/js/polar_refine.js` — sample pipeline + recommendation engine
- NEW: `public/js/polar_view.js` — canvas polar plot + table renderer (or extend `analysis.js`)
- MODIFY: `public/index.html` — retitle/replace the Beating tab, new container divs, script tags (order matters), `accept=".csv,.pol"` on file input
- MODIFY: `public/js/app.js` — dispatch uploads by extension, new `switchView('polars')` case, share `detectTacks/detectGybes` with refinement module, update `UNITS`/`about-container` copy
- MODIFY: `public/css/style.css` — polars tab, table colour scale, slider controls
- MODIFY: `CLAUDE.md` — document new module and the polar-refinement workflow

## Verification

- **Stage 1:** load a known `.pol`, confirm every cell in the table matches the file by eye; polar plot curves pass through the tabulated points; `lookupBsp` at a known grid point returns the tabulated BSP and at a midpoint returns a plausible interpolation.
- **Stage 2:** on a known calm-then-breezy log, the sample scatter should thin out around tacks/gybes and during mark roundings visible on the Map tab; tightening the TWS-stability threshold should visibly remove shifty-wind samples.
- **Stage 3:** apply a log you know the boat underperformed in — proposed polar should mostly stay ≤ existing (no phantom gains). Apply a log you know was fast — proposed polar should lift where it's well-sampled. Cells with no data should not change.
- **Stage 4:** compare observed best upwind TWA against the polar's `0 VMG` angle; the shift should be consistent across TWS bands with enough data, and match your subjective recall from the sessions.
- **Stage 5:** reload the exported `.pol` in Expedition, confirm it parses; diff the files to verify only intended cells changed.
