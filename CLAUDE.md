# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

Commit and push changes directly to master.

## Session startup

1. `git pull origin master` — sync with remote before anything else
2. `npm start` — run dev server at http://localhost:3000

## Commands

```bash
npm start        # Run dev server at http://localhost:3000
```

No build step, no bundler, no tests. The server is a one-liner Express static file server (`server.js`). All logic runs client-side.

**Deployment:** Vercel static site — `outputDirectory: public`, no framework, no build command.

## Architecture

Pure vanilla JS, no frameworks, no modules. All JS files are loaded via `<script>` tags in `index.html` and expose globals. Script load order matters:

1. `parser.js` → `Parser`
2. `polar.js` → `Polar` (.pol parsing, bilinear interpolation, serialise)
3. `polar_refine.js` → `PolarRefine` (windowed sample generation + quality filters)
4. `polar_view.js` → `PolarView` (polar tab table + polar plot canvas + sample overlay)
5. `map.js` → `MapManager`
6. `playback.js` → `Playback`
7. `graph.js` → `Graph`
8. `app.js` → `App` (wires everything together, calls `App.init()` on DOMContentLoaded)

Each module is an IIFE returning a public API object.

### Data flow

1. User uploads Expedition CSV files → `Parser.parse()` → boat object
2. `App.addBoat()` stores it in `boats: Map<name, {boat, fieldTimeseries}>`
3. `fieldTimeseries` is a precomputed `Map<fieldId, [{ts,val}]>` for fast carry-forward lookups (`carryForward()` uses binary search)
4. `Playback` drives a 50ms interval timer; each tick calls `App.onTick(ts)` → `MapManager.updateMarker()` + variable panel updates

### Expedition CSV format

- Line 0: `!Boat,Utc,field1,field2,...` (column names)
- Line 1: `!boat,0,id1,id2,...` (field IDs — integers)
- Remaining lines: `boatId,oleTimestamp,fieldId,value,fieldId,value,...` (sparse key-value pairs per row)
- Timestamps are OLE Automation dates (days since 1899-12-30); converted to ms via `oleToMs()`
- `boatId === '0'` = own boat GPS; other IDs are AIS/fleet contacts

### Key data structures

**boat object** (from `Parser.parse()`):
```
{ name, color, fieldMap: {id→name}, nameToId: {name→id}, rows, gpsRows, minTs, maxTs }
```
- `rows`: all rows including non-GPS
- `gpsRows`: boatId=0 only, GPS-spike-filtered, sorted by ts

**App state:**
- `boats: Map<name, {boat, fieldTimeseries}>` — loaded boats
- Playback trim is in `Playback` state (`trimStart`/`trimEnd` as ms timestamps)
- `currentView`: `'map' | 'polars' | 'twd' | 'gybe' | 'graph' | 'stats' | 'about' | 'race'`
- `loadedPolar`: parsed Expedition `.pol` file (see polar.js), null until user loads one

### Views

- **Map** (`map-container`): Leaflet map with CartoDB light + OpenSeaMap seamark overlay. Each boat gets a polyline + oriented boat icon. Trim dims the full track and adds a bright trim polyline. Tack mode replaces the polyline with coloured segments (port=red, stbd=green). Wind barbs are Leaflet DivIcons with inline SVG, rotated by TWD, scaled by zoom level.
- **Polars** (`polars-container`): Table + polar-plot view of a loaded Expedition `.pol` file. Upwind/downwind VMG-optimal angles per TWS row are detected (any TWA between 30–170° that is not a multiple of 10°) and highlighted. Stage 2 adds a per-log quality-window selector and a parameters panel (averaging window, stride, manoeuvre exclusion, ΔTWS / ΔTWD / HDG-swing thresholds, min BSP); `PolarRefine.generateSamples()` runs live, and 60 s averaged samples are overlaid on the polar plot, coloured by their nearest TWS curve. See `Specification/Polars-plan.md` for the staged plan.
- **Tacking** (`twd-container`): VMG chart + table of tack events. Each row shows port/stbd TWD, shift, and ground lost. Summary row shows total tacks, TWA correction (avg shift ÷ 2), avg ground lost, avg TWS. Rows with unstable wind (range >10° in ±30–60s windows) are highlighted red.
- **Gybing** (`gybe-container`): Same structure as Tacking but for downwind manoeuvres. VMG is negated so the chart shows positive downwind progress.

### TWD/tack detection logic

`detectTacks()` in `app.js`: finds TWA sign changes (excluding |TWA|≥90°), interpolates zero-crossing time, looks up average TWD in 30–60s windows before/after the tack, flags as unstable if the TWD range in either window exceeds 10°. Ground lost is calculated by integrating VMG over a ±60s window and comparing to baseline VMG.

`detectGybes()` mirrors the same logic but triggers on |TWA|≥90° sign changes.

### Field value lookups

`getFieldValue(entry, fieldName, ts)` → carry-forward (last known value before `ts`). Returns `null` if the field doesn't exist or `ts` is before the first data point.
