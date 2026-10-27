// Aerial imagery catalog, grouped by state so more states can be added later without touching the picker.
//
// Every source is a candidate: for each site the app samples all candidates that cover it, throws out the ones
// that come back blank or with gaps, measures how much real detail each one has, and uses the sharpest.
// So adding a source here never makes results worse — at most it costs a little time while sources are checked.
//
// Fields
//   id        unique id (used in the Settings choice and saved projects)
//   label     shown in Settings and in the README / Data sources
//   kind      'map'   ArcGIS MapServer /export (the server reprojects into the State Plane zone)
//             'image' ArcGIS ImageServer /exportImage (same)
//             'tiles' cached map tiles; Web Mercator grids are warped here, a State Plane grid is used directly
//                     when it is the site's zone (tile grid read from the service, unless `tiles` is a template)
//   url       service address (MapServer / ImageServer)
//   tiles     optional {z}/{y}/{x} template (for kind 'tiles', or as a fallback for a 'map' source)
//   flights   true for a mosaic ImageServer whose catalog lists separate flights: each flight under the site
//             becomes its own candidate (locked to that flight)
//   bounds    lon/lat box [w, s, e, n] — a quick first filter only; real coverage is checked from the pixels
//   year      year flown (null when not published)
//   nativeIn  published pixel size in inches, when known (a measurement never reports finer than this)
//   auto      false = never picked automatically (event imagery: floods, storm damage); still selectable by hand
//   credit    attribution line for the README and map exports
//   publisher who publishes it (shown in Settings)
//
// Checked from the github.io origin on 2026-10-27: every service below allows browser requests.

const AR = [-94.65, 32.95, -89.58, 36.55];
const ARGIS = 'https://gis.arkansas.gov/arcgis/rest/services/ImageServices';

/** National sources: always candidates, anywhere in the US. */
export const NATIONAL = [
  { id: 'esri', label: 'Esri World Imagery', kind: 'map', year: null,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZ: 22, wgs84: true,
    credit: 'Esri World Imagery (Esri, Maxar, Earthstar Geographics)', publisher: 'Esri' },
  { id: 'usgs', label: 'USGS National Map (about 1 m)', kind: 'map', year: null,
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer',
    credit: 'USGS The National Map: Orthoimagery (public domain)', publisher: 'USGS' },
];

/** Local catalogs by state (two-letter code). */
export const STATES = {
  AR: {
    name: 'Arkansas',
    bounds: AR,
    sources: [
      // ---- Arkansas GIS Office (statewide) ----
      { id: 'arcomp', label: 'Arkansas GIS Office — city/county flights', kind: 'image', flights: true, bounds: [-94.63, 33.33, -89.6, 36.54],
        url: `${ARGIS}/High_Resolution_Composite/ImageServer`,
        credit: 'Arkansas GIS Office High Resolution Composite', publisher: 'Arkansas GIS Office',
        // Flights in that mosaic that duplicate a statewide service listed below.
        skipFlights: /^ADOP_/i },
      { id: 'ar2023', label: 'Arkansas statewide 2023 (9 in)', kind: 'image', bounds: AR, year: 2023, nativeIn: 7.87,
        url: `${ARGIS}/IMAGERY_9IN_2023/ImageServer`,
        credit: 'Arkansas GIS Office, ADOP 2023 9-inch orthoimagery', publisher: 'Arkansas GIS Office' },
      { id: 'ar2017', label: 'Arkansas statewide 2017 (1 ft)', kind: 'image', bounds: AR, year: 2017, nativeIn: 11.81,
        url: `${ARGIS}/IMAGERY_1FT_2017/ImageServer`,
        credit: 'Arkansas GIS Office, ADOP 2017 1-foot orthoimagery', publisher: 'Arkansas GIS Office' },
      { id: 'arflood2019', label: 'Arkansas River flood, May 2019 (6 in)', kind: 'image', bounds: [-94.51, 33.74, -90.78, 35.54],
        year: 2019, nativeIn: 5.91, auto: false,
        url: `${ARGIS}/IMAGERY_6IN_MAY19FLOOD/ImageServer`,
        credit: 'Arkansas GIS Office, May 2019 Arkansas River flood 6-inch imagery', publisher: 'Arkansas GIS Office' },

      // ---- Pulaski County ----
      { id: 'pagis2024', label: 'PAgis 2024 — Pulaski County', kind: 'map', bounds: [-92.757, 34.483, -92.024, 35.015], year: 2024,
        url: 'https://www.pagis.org/arcgis/rest/services/MAPS/AerialPhotos2024/MapServer',
        credit: 'Pulaski Area GIS (PAgis) 2024 orthophotography', publisher: 'Pulaski Area GIS' },
      { id: 'pagis2021', label: 'PAgis 2021 — Pulaski County', kind: 'map', bounds: [-92.757, 34.483, -92.024, 35.015], year: 2021,
        url: 'https://www.pagis.org/arcgis/rest/services/MAPS/AerialPhotos2021/MapServer',
        credit: 'Pulaski Area GIS (PAgis) 2021 orthophotography', publisher: 'Pulaski Area GIS' },

      // ---- Northwest Arkansas ----
      { id: 'rogers2026', label: 'City of Rogers 2026', kind: 'image', bounds: [-94.268, 36.249, -93.975, 36.419], year: 2026, nativeIn: 6,
        url: 'https://gis.rogersar.gov/gis/rest/services/Aerial/Aerial_2026/ImageServer',
        credit: 'City of Rogers, Arkansas, Dept. of Community Development — 2026 aerials', publisher: 'City of Rogers' },
      { id: 'rogers2025', label: 'City of Rogers 2025', kind: 'image', bounds: [-94.266, 36.25, -93.976, 36.417], year: 2025, nativeIn: 6,
        url: 'https://gis.rogersar.gov/gis/rest/services/Aerial/Aerial_2025/ImageServer',
        credit: 'City of Rogers, Arkansas, Dept. of Community Development — 2025 aerials', publisher: 'City of Rogers' },
      { id: 'fay2026', label: 'City of Fayetteville 2026', kind: 'map', bounds: [-94.406, 35.945, -93.91, 36.266], year: 2026,
        url: 'https://maps.fayetteville-ar.gov/server/rest/services/Imagery/2026_WGS84/MapServer',
        credit: 'City of Fayetteville, Arkansas — 2026 imagery (Bowman; EagleView Technologies; Sanborn)', publisher: 'City of Fayetteville' },
      { id: 'fay2025', label: 'City of Fayetteville 2025', kind: 'map', bounds: [-94.406, 35.945, -93.91, 36.22], year: 2025,
        url: 'https://maps.fayetteville-ar.gov/server/rest/services/Imagery/2025_WGS84/MapServer',
        credit: 'City of Fayetteville, Arkansas — 2025 imagery (EagleView Technologies; Surdex)', publisher: 'City of Fayetteville' },
      { id: 'nwa2024', label: 'Benton & Washington Counties 2024', kind: 'tiles', bounds: [-94.643, 35.726, -93.785, 36.529], year: 2024,
        url: 'https://tiles.arcgis.com/tiles/G4bYaaas92zuKaUR/arcgis/rest/services/BentWashImg2024Pack/MapServer',
        credit: 'NWA two-county imagery 2024 (NWARPC; Washington County; Benton County)', publisher: 'NWARPC / University of Arkansas (ArcGIS Online)' },
      { id: 'swu2026', label: 'Springdale area 2026', kind: 'tiles', bounds: [-94.35, 36.08, -93.913, 36.313], year: 2026,
        url: 'https://tiles.arcgis.com/tiles/QRmTMEqtRjkZ85qX/arcgis/rest/services/2026_Aerial_32_bit/MapServer',
        credit: '2026 aerial imagery (published on ArcGIS Online by an "SWU" account)', publisher: 'SWU account on ArcGIS Online (publisher not confirmed)' },
      { id: 'centerton2023', label: 'City of Centerton 2023', kind: 'tiles', bounds: [-94.371, 36.288, -94.231, 36.428], year: 2023,
        url: 'https://tiles.arcgis.com/tiles/bKcjRqUhqaFX7J81/arcgis/rest/services/Centerton_Aerial_Imagery_2023/MapServer',
        credit: 'Centerton aerial imagery 2023', publisher: 'Centerton planning (ArcGIS Online)' },

      // ---- River Valley ----
      { id: 'fortsmith2023', label: 'City of Fort Smith 2023', kind: 'tiles', bounds: [-94.472, 35.22, -94.06, 35.726], year: 2023,
        url: 'https://gis.fortsmithar.gov/arcgis/rest/services/2023Aerials/MapServer',
        credit: 'City of Fort Smith, Arkansas — 2023 aerials', publisher: 'City of Fort Smith' },
      { id: 'russ2024', label: 'Russellville 2024', kind: 'tiles', bounds: [-93.266, 35.198, -93.022, 35.424], year: 2024,
        url: 'https://tiles.arcgis.com/tiles/g2qMSCNar9dcOtYq/arcgis/rest/services/2024_Aerials/MapServer',
        credit: 'Russellville 2024 aerials (City Corporation)', publisher: 'City Corporation, Russellville (ArcGIS Online)' },

      // ---- Garland County ----
      { id: 'hs2025', label: 'City of Hot Springs 2025', kind: 'tiles', bounds: [-93.42, 34.38, -92.78, 34.78], year: 2025,
        url: 'https://tiles.arcgis.com/tiles/lCwVhIwyitVebu0v/arcgis/rest/services/Aerial_2025b/MapServer',
        credit: 'City of Hot Springs, Arkansas — 2025 aerials', publisher: 'City of Hot Springs (ArcGIS Online)' },
      { id: 'hs2023', label: 'City of Hot Springs 2023', kind: 'tiles', bounds: [-93.42, 34.37, -92.78, 34.78], year: 2023,
        url: 'https://tiles.arcgis.com/tiles/lCwVhIwyitVebu0v/arcgis/rest/services/Aerial_2023/MapServer',
        credit: 'City of Hot Springs, Arkansas — 2023 aerials', publisher: 'City of Hot Springs (ArcGIS Online)' },

      // ---- White County ----
      { id: 'white', label: 'White County aerials', kind: 'tiles', bounds: [-91.959, 35.158, -91.373, 35.461], year: null,
        url: 'https://tiles.arcgis.com/tiles/XbJRPvfPU3c1mEWY/arcgis/rest/services/White_County_Aerials_2_tpkx/MapServer',
        credit: 'White County aerials (ArcGIS Online)', publisher: 'ArcGIS Online account (publisher not confirmed)' },
    ],
  },
};

// Each local source knows its state (Settings groups them by it).
for (const [code, st] of Object.entries(STATES)) for (const s of st.sources) s.state = code;

/** States with a local catalog, for Settings. */
export const STATE_LIST = Object.entries(STATES).map(([code, s]) => ({ code, name: s.name, count: s.sources.length, bounds: s.bounds }));
