# ThreadTerm application icon

The mark joins an upright T and a slightly offset inverted T on a purple-blue rounded tile. Geometry and colors live in `threadterm.svg`; this is an original vector mark, not an Electron fallback or a font glyph.

Regenerate committed artifacts with `python desktop/assets/generate-icons.py` (Pillow required). The script renders the simple SVG rectangles with supersampling and writes the 512px PNG, 32px tray PNG, Windows ICO frames at 16/20/24/32/40/48/64/128/256px, and `icon-data.ts`.

Electron main imports the generated PNG data URLs into its bundle. Every main/floating BrowserWindow receives the application NativeImage; Tray receives the small image. No runtime asset paths are required, including manually bundled isolated QA applications. Standard builds consume the committed artifacts and do not require Python.

electron-builder explicitly consumes the ICO for Windows executable resources and NSIS installer/uninstaller resources. Keep these packaging references together. Changing only the icon requires a desktop/package rebuild, not a Rust runtime rebuild. Verify the resulting executable icon through Windows shell extraction and live WM_GETICON; checking only that an ICO source exists does not prove packaging correctness.
