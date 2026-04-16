# Sailing Analysis

A client-side web app for analysing Expedition sailing log files.

**Live app:** https://sailing-analysis.vercel.app

## Features

- **Map view** — plots GPS tracks on a nautical chart (CartoDB + OpenSeaMap overlay), with an oriented 2D boat icon that rotates to match heading
- **Playback** — scrub or play back the track in time with adjustable speed; trim to a specific window
- **Tack colouring** — colour the track by tack (port = red, starboard = green)
- **Wind barbs** — display TWD/TWS wind barbs along the track at configurable intervals
- **Beating plot** — scatter plot of boat speed vs true wind angle for upwind analysis
- **TWD table** — detects tacks and shows port/starboard TWD and shift at each one; flags unstable wind conditions

## Usage

Upload one or more Expedition CSV log files using the **+ Upload Files** button or drag and drop onto the map. Multiple boats can be loaded simultaneously for comparison.

## Running locally

```bash
npm start
```

Opens at http://localhost:3000.

## Data format

Expects Expedition software CSV log files (`.csv`). The parser reads the Expedition sparse key-value format and handles OLE Automation timestamps, GPS spike filtering, and AIS/fleet contact separation automatically.
