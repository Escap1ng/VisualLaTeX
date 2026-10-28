# VisualLaTeX Studio

**A LaTeX / PostScript project editor with local compilation, PDF preview and export.**

This workspace edition extends [Escap1ng/VisualLaTeX](https://github.com/Escap1ng/VisualLaTeX) with full source editing, multiple files, references, bibliography entries, ZIP projects and real compilation. No npm packages or build step are required. Compilation uses Node.js 22+ and a local typesetting toolchain.

## Start

The sample project contains `main.tex`, `references.bib` and `drawing.ps`. Opening `index.html` directly supports editing; use the local service for PDF preview and export.

### Windows

Install [Node.js 22 or newer](https://nodejs.org/en/download), unpack this project and run PowerShell in its directory:

```powershell
.\setup-windows.ps1
.\start.ps1
```

If PowerShell blocks scripts under its default policy, use `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-windows.ps1` for that invocation, and likewise for `start.ps1`. No system policy change is required.

Setup downloads pinned official Tectonic 0.17.0, Ghostscript 10.08.0 and extraction tools, verifies their published SHA-256 digests, and unpacks them under `.tools`. It never runs the installers, changes the registry, or overwrites project files. Existing tools are retained on subsequent runs; failed downloads and staging files remain available for inspection. Third-party engine binaries are not distributed in this source archive; their licenses remain in their download packages.

Open the address printed by the terminal, normally `http://127.0.0.1:4173`. Keep the terminal running and press Ctrl+C to stop. Use `.\start.ps1 -Port 4174` to choose another port.

### macOS, Linux or an existing toolchain

Install [Tectonic](https://tectonic-typesetting.github.io/book/latest/installation/index.html) or XeLaTeX and [Ghostscript](https://ghostscript.com/releases/gsdnld.html), make their executables available on PATH, then run:

```bash
node server.mjs
```

Executable paths can also be supplied using `VISUALLATEX_TECTONIC`, `VISUALLATEX_XELATEX`, and `VISUALLATEX_GHOSTSCRIPT`. XeLaTeX bibliography tools accept `VISUALLATEX_BIBTEX` and `VISUALLATEX_BIBER`. Set XeLaTeX explicitly to choose an existing TeX distribution; do not configure both LaTeX engines at once.

Tectonic downloads missing TeX support files on first use and caches them for later compilation. Source is compiled locally and is not uploaded to a third-party service. The Windows launcher uses `.tools/cache`; `TECTONIC_CACHE_DIR` overrides this location. Existing TeX distributions manage their own packages and fonts.

### Editing and PDF output

- Add individual files, open a project folder, or import a ZIP project.
- Edit any text file in source mode, including preambles, macros, references and incomplete source.
- Complete LaTeX documents can switch to the visual editor. Fragments, BibTeX, PostScript and EPS text remain directly editable source.
- Download one file or export the entire project as ZIP, including binary resources and changes in inactive files.
- Select the complete LaTeX main document or a PS/EPS file, then compile/render with the button or Ctrl/Cmd+Enter.
- Inspect the generated PDF and export it. Running tasks can be cancelled; errors retain engine logs for diagnosis.

Source changes mark an older PDF as stale. Export recompiles changed content before downloading, while failed compilation keeps the previous preview visibly marked and leaves the source editable. With Ghostscript installed, pages are displayed as images using Previous/Next controls, without requiring a browser PDF plugin. Without Ghostscript, the UI explains the limitation and falls back to native PDF display; the complete PDF remains exportable.

Image preview supports the first 100 pages on a fixed 1200×1600 canvas with each complete page fitted proportionally. This does not change the exported PDF's page dimensions, vector content or page count. Images are generated on demand with a 20-second limit and can be retried after failure. Use the exported PDF to select or copy text.

Direct `file://` pages and GitHub Pages remain editing-only. Browser drafts are isolated by origin: export a ZIP from the old offline page before switching to the local service, then import it there.

Opening a folder or project replaces the current workspace after confirmation. Adding individual files preserves existing files and assigns new names to duplicates. Renaming a path does not rewrite source references automatically.

## Features

| Feature | Support |
| --- | --- |
| Source files | TeX, LaTeX, STY, CLS, BIB, PS, EPS and UTF-8 text with custom extensions |
| Project management | Create, rename, delete, select main file and preserve relative paths |
| References | Navigate labels, citation locations and BibTeX entries; insert cite/ref/label and add entries |
| Find and replace | Current-file search, wrap-around, replace one/all and case sensitivity |
| History | Independent per-file undo/redo for source and visual changes |
| PostScript | PS/text EPS source, page/procedure outline, templates, UTF-8 and Latin-1 |
| Resources | Preserve original binary bytes, including binary EPS |
| Archives | Read stored/deflated ZIP and export standard ZIP without packages |
| Drafts | Atomic local project snapshots and legacy single-file migration |
| LaTeX compilation | Tectonic or XeLaTeX with project files, resources, references and bibliography processing |
| PostScript rendering | Ghostscript converts PS/EPS to PDF; EPS uses BoundingBox cropping |
| PDF output | Target selection, preview, cancellation, logs, stale-result tracking and current-source export |

Double-click a protected visual command to locate its editable source; double-click a formula to edit it. Unsupported visual structures remain editable raw TeX. New `main.tex` files have a document template; other TeX files start empty for use as fragments.

Shortcuts: Ctrl/Cmd+S saves locally, Ctrl/Cmd+F opens find/replace, Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, Ctrl/Cmd+Enter compiles/renders, and Tab inserts two spaces. The encoding button explicitly switches UTF-8/Latin-1; unencodable characters are rejected rather than replaced.

## Limits

Projects allow 500 files and 50 MB of expanded content; ZIP input allows 100 MB. Encrypted, multi-disk and ZIP64 archives are unsupported. Browser storage quotas may be smaller; export ZIP backups for larger projects. Undo history is session-local.

Project name, main file and active file are stored in the ZIP comment without reserving or replacing any user filename. Third-party repacking may remove these settings; project source and resources can still be imported.

Compilation is explicit and has a default 180-second timeout; initial support-file downloads may take longer. Tectonic performs TeX/BibTeX passes automatically. BibLaTeX/Biber projects should use XeLaTeX with Biber installed. CJK and custom fonts must be available to the toolchain. Packages requiring shell escape, such as some minted workflows, are unsupported. Full typesetting and diagnostics come from the engine; the visual editor is not a complete TeX parser.

Font validation limitation: with Tectonic 0.17.0 and the default ctex/Fandol fonts, the tested Chinese PDF looked correct but copied/extracted text had incorrect character mappings. On Windows with the corresponding system fonts installed, explicitly using `\usepackage[UTF8,fontset=windows]{ctex}` restored text copying in the tested sample. The application never changes project font settings automatically; other platforms and font combinations need separate verification.

The service binds only to loopback and validates Host, Origin and a session token. Temporary project directories are removed after jobs finish. Tectonic uses `--untrusted`, XeLaTeX disables shell escape, and Ghostscript uses `SAFER`. These options **are not an operating-system sandbox**: compile trusted local projects, and do not expose this service as a public compilation server.

## Development

Node.js 22+, no npm installation:

```bash
node --check main.js
node --check workspace.js
node --check preview.js
node --check compiler.mjs
node --check server.mjs
node tests/smoke.mjs
node --test
```

Tests exercise actual functions and UI event handlers, compiler process orchestration, loopback service boundaries, cancellation and stale results. Regular tests use simulated engines and do not need the toolchain. The minimal DOM model does not verify browser layout or actual TeX/PS typesetting. CI checks `main`/`dev`; publishing and deployment wait for checks. GitHub Pages serves only the static editor.

See the [browser acceptance checklist](tests/browser-acceptance.md) for manual end-to-end validation. Actual engine validation in this iteration used Tectonic and Ghostscript; the XeLaTeX path has not yet been verified against a real distribution.

`workspace.js` coordinates editing, `project-model.js` owns canonical source/history/indexes, and `project-archive.js` handles ZIP. `preview.js` manages PDF state and export; `compiler.mjs` and `server.mjs` run the local compilation service, while `pdf-preview.mjs` renders bounded page images. `setup-windows.ps1` and `start.ps1` prepare portable tools and start the service. The original `main.js` remains the visual LaTeX conversion core.

## License

[Apache-2.0](LICENSE). Based on the original project by Escap1ng.
