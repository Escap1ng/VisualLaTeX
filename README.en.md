# VisualLaTeX Studio

**An offline project editor for LaTeX and PostScript.**

This workspace edition extends [Escap1ng/VisualLaTeX](https://github.com/Escap1ng/VisualLaTeX) with full source editing, multiple files, references, bibliography entries and ZIP projects. It has no runtime dependencies or build step.

## Start

Unpack the source archive and open `index.html`. The sample project contains `main.tex`, `references.bib` and `drawing.ps`.

- Add individual files, open a project folder, or import a ZIP project.
- Edit any text file in source mode, including preambles, macros, references and incomplete source.
- Complete LaTeX documents can switch to the visual editor. Fragments, BibTeX, PostScript and EPS text remain directly editable source.
- Download one file or export the entire project as ZIP, including binary resources and changes in inactive files.

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

Double-click a protected visual command to locate its editable source; double-click a formula to edit it. Unsupported visual structures remain editable raw TeX. New `main.tex` files have a document template; other TeX files start empty for use as fragments.

Shortcuts: Ctrl/Cmd+S saves locally, Ctrl/Cmd+F opens find/replace, Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, Tab inserts two spaces. The encoding button explicitly switches UTF-8/Latin-1; unencodable characters are rejected rather than replaced.

## Limits

Projects allow 500 files and 50 MB of expanded content; ZIP input allows 100 MB. Encrypted, multi-disk and ZIP64 archives are unsupported. Browser storage quotas may be smaller; export ZIP backups for larger projects. Undo history is session-local.

Project name, main file and active file are stored in the ZIP comment without reserving or replacing any user filename. Third-party repacking may remove these settings; project source and resources can still be imported.

The editor **does not execute or render TeX/PostScript and does not compile PDF**. Use an existing TeX/Ghostscript toolchain with the exported files. It does not expand TeX macros or provide full syntax diagnostics. Source mode remains available when visual editing is unsupported.

## Development

Node.js 22+, no npm installation:

```bash
node --check main.js
node --check workspace.js
node tests/smoke.mjs
node --test
```

Tests exercise actual functions and UI event handlers with a minimal DOM model, not a browser engine or TeX/PS compiler. CI checks `main`/`dev`; publishing and deployment wait for checks.

`workspace.js` coordinates the UI, `project-model.js` owns canonical source/history/indexes, and `project-archive.js` handles ZIP. The original `main.js` remains the visual LaTeX conversion core.

## License

[Apache-2.0](LICENSE). Based on the original project by Escap1ng.
