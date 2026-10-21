# Contours to Revit — Revit 2026 plugin

Adds **AMR › Site › Contours to Revit** to Revit 2026. The button opens the live web app
(https://amrjacob.github.io/Contours-to-Revit/) in a window inside Revit. The web app gains a
**Send to Revit** section that creates or updates, at the Project Base Point:

- the **existing ground** Toposolid (phase Existing, demolished in the last phase),
- the **proposed grading** Toposolid from Site design (last phase),
- the **aerial** as a linked image in a plan view,
- the **contour/context DXF** and the **proposed DXF** as pinned links.

Everything goes in as one undo step. The placement (origin, project north, datum), the file folder and a copy
of the site + design are saved inside the .rvt, so later sends — and coworkers — land in the same spot, and
*Open the site saved in this model* brings the design back.

## Install (for coworkers)

Download **ContoursToRevit-Setup.exe** from the
[latest release](https://github.com/AMRJacob/Contours-to-Revit/releases/latest), close Revit, run it.
No admin rights; it installs for the current Windows user into
`%AppData%\Autodesk\Revit\Addins\2026`. Uninstall from Windows Settings › Apps.

- Windows may say the publisher is unknown (the installer isn't code-signed): **More info › Run anyway**.
- Revit asks once whether to load the unsigned add-in: **Always Load**.

## How web changes reach the plugin

The plugin is a thin shell: all UI and all coordinate math live in the web app (`js/revit.js`), so pushing
the website updates the plugin for everyone. The plugin only needs a new installer when the Revit side changes
(`revit-plugin/src`). Then bump `revit-plugin/version.txt`; the **Revit plugin** workflow builds the installer
and publishes release `revit-vX.Y.Z`. The web app shows an update banner inside Revit when a newer release exists.

## Messages (web → plugin)

`hello`, `getModel`, `chunk` (base64 file upload), `pickFolder`, `openFolder`, `openUrl`, `select`, `import`, `setUrl`.
Replies: `{ type: "reply", id, ok, result | error }`. Event: `{ type: "event", event: "documentChanged" }`.
All lengths sent to `import` are Revit internal feet, already placed at the Project Base Point.

Test the panel in an ordinary browser with `?host=mock` (a simulated plugin; `window.c2rMock` shows the jobs).

## Notes

- Revit 2026 loads its own WebView2 assemblies; the plugin references an older version and uses Revit's copy,
  falling back to the copy in `ContoursToRevit\webview2`.
- Browser data (projects saved in the web app) inside Revit is kept in `%LocalAppData%\ContoursToRevit\WebView2`,
  separate from Chrome/Edge.
- Developer option: `%AppData%\ContoursToRevit\settings.json` → `"Url"` points the window at another copy of the web app.
