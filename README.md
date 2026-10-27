# Contours to Revit

**Live app:** https://amrjacob.github.io/Contours-to-Revit/

Select a site on a map and download preliminary topography ready for Revit — for feasibility and early design before a survey exists.

> **Preliminary only — not survey data.** Elevations are USGS 3DEP bare-earth DEMs, interpolated under buildings and trees.

## Outputs
| File | Use |
|---|---|
| `*_points.csv` | X,Y,Z (no header) for Revit Toposolid → *Create from Import → Specify Points File* |
| `*_contours.dxf` | AutoCAD R12, 3D polylines with true Z; layers `C-TOPO-MAJR`, `C-TOPO-MINR`, `C-TOPO-TEXT` |
| `*_points.dxf` | Same grid as the CSV, as 3D points (`C-TOPO-PNTS`) |
| `*_map.png` | Printable contour map over aerial imagery, north arrow, scale bar |
| `*_README.txt` | Source datasets & collection dates, resolution, datum, zone, units, disclaimer |

## How it works
Runs entirely in the browser — no server.
- **Elevation:** USGS 3DEP ImageServer (`elevation.nationalmap.gov`). The app queries the catalog for datasets covering the site and requests the 1 m lidar DEM first, filling any gaps from 1/9″, 1/3″ and 1″ DEMs, and reports the share of the site each resolution covers.
- **Coordinates:** NAD83 State Plane zones (feet) generated from the EPSG registry (`js/zones.js`). The zone is auto-detected from the county (OpenStreetMap reverse geocoding) and can be overridden.
- **Contours:** marching squares on a regular State Plane grid, optional light smoothing (contours only).
- **Imagery:** every service that may cover the site is checked — Arkansas GIS Office statewide sets and its city/county flights, city and county services (PAgis, Rogers, Fayetteville, Fort Smith, Hot Springs, Russellville, NW Arkansas, …), Esri and USGS. Sources that come back blank or patchy are skipped, the real detail in each is measured from sample pixels, and the sharpest is used (Settings › Aerial imagery shows the comparison and lets you pick another, or prefer newer photos). The catalog is grouped by state in `js/imgcatalog.js` so other states can be added. Falls back to hillshade if nothing answers.

## Development
Static site — no build step. Libraries are vendored in `lib/` (Leaflet 1.9.4, Leaflet.draw 1.0.4, proj4 2.11.0, geotiff.js 2.1.3, JSZip 3.10.1; licenses in `lib/licenses`).
Serve the folder with any static server (ES modules don't load from `file://`), e.g. `python -m http.server`.
