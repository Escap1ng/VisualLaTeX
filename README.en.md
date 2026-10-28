<div align="center">

# VisualLaTeX

**Import · Tweak · Export — an offline LaTeX light editor that preserves original source**

[![Version](https://img.shields.io/badge/Version-v2.0.2-6f42c1)](https://github.com/Escap1ng/VisualLaTeX/releases)
[![License](https://img.shields.io/badge/License-Apache_2.0-0366d6)](./LICENSE)
[![CI](https://github.com/Escap1ng/VisualLaTeX/actions/workflows/ci.yml/badge.svg)](https://github.com/Escap1ng/VisualLaTeX/actions/workflows/ci.yml)
[![Online Demo](https://img.shields.io/badge/Online_Demo-GitHub_Pages-00b4d8)](https://Escap1ng.github.io/VisualLaTeX/)
[![Dependencies](https://img.shields.io/badge/Dependencies-none-959da5)](https://github.com/Escap1ng/VisualLaTeX/actions/workflows/build.yml)

[中文](README.md) · **English**

</div>

---

<div align="center">

![VisualLaTeX editor screenshot](screenshots/editor.png)

</div>

## Why This Exists

It's the night before the deadline, and your advisor only asked you to "change a few sentences and reword a title" — yet the moment you open the `.tex` file, a wall of backslashes and braces stares back at you. Overleaf is great, but it is designed for people who write code. You just want a small, safe change.

**VisualLaTeX was built for exactly that:**

| Scenario | Traditional Code Editor | VisualLaTeX |
|:---|:---|:---|
| Small-edit efficiency | Manually locate structures in source | WYSIWYG, click and edit |
| Risk of breakage | Easy to corrupt commands & environments | Complex structures locked verbatim |
| Learning curve | Requires LaTeX fluency | If you can use Word, you're set |

## Core Workflow

**Import `.tex` → light visual edits → export `.tex`**

Unedited source blocks retain their original comments, whitespace, and line endings. Edited regions are regenerated as LaTeX. Structures that cannot be safely converted stay in editable source blocks, fully offline.

## Features

| Feature | Details |
|:---|:---|
| One-click import | Open a local `.tex`; sections, paragraphs, lists, formulas, and images become visual elements |
| Split-pane view | Visual editor on the left, live LaTeX source preview on the right |
| Basic formatting | Three heading levels, bold, italic, center, ordered/unordered lists |
| Formula input | 30+ symbols; `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`; double-click visual formulas to edit |
| Verbatim blocks | Tables, bibliographies, code listings shown as-is, editable, never lost on export |
| Command protection | `\cite`, `\ref`, and other reference commands preserved verbatim |
| Image insertion | Enter a path to generate the `figure` float environment |
| One-click export | Copy source or download `.tex`, reusing the imported file name |
| Auto-save | Drafts cached together with the preamble; content survives page refresh |

## Quick Start

**Zero install · zero dependencies · zero build** — clone and double-click to run offline:

```bash
git clone https://github.com/Escap1ng/VisualLaTeX.git
```

Then double-click `index.html`. That's it.

You can also use the [online demo](https://Escap1ng.github.io/VisualLaTeX/) (auto-deployed by GitHub Actions).

## Project Structure

```
VisualLaTeX/
├── index.html    # Main page (layout, toolbar)
├── style.css     # Global styles
├── main.js       # Editor core, .tex parsing, DOM↔LaTeX conversion
├── tests/        # Zero-dependency smoke and import/export/editing regression checks
├── .github/      # GitHub Actions workflows (CI / release / Pages)
├── README.md     # Docs (Chinese)
└── README.en.md  # Docs (English)
```

## Continuous Integration

Automation is powered by GitHub Actions:

| Workflow | Trigger | Purpose |
|:---|:---|:---|
| CI | push or PR to `main` or `dev` | Syntax, asset integrity, and import/export/editing regression tests |
| Build & Release | push `v*` version tag | Package and release only after checks pass on that commit |
| Deploy to GitHub Pages | push to `main` | Deploy the [online demo](https://Escap1ng.github.io/VisualLaTeX/) only after checks pass on that commit |

Run locally with Node.js 22+; no npm packages are needed:

```bash
node --check main.js
node tests/smoke.mjs
node --test
```

Regression checks cover HTML injection, source round trips, local edits, formulas, images, escaping, and draft recovery. DOM checks use a minimal model; they do not replace real browser interaction or TeX compilation tests.

## Recommended Workflow

Import the `.tex` you want to touch up → make visual text and structure adjustments → export and download → drop it back into your project and compile.

<details>
<summary><b>Known Limitations</b></summary>

1. Built on `contenteditable`; complex editing behavior still needs validation in individual browsers
2. No visual table editing (tables are edited as source inside verbatim blocks)
3. Complex/nested environments, multiple images, custom list labels, and `equation` environments use editable source blocks; TeX macros are not expanded
4. This is a light editing tool; for large-scale rewrites, use a code editor

</details>

<details>
<summary><b>Version History</b></summary>

- **v2.0.2**: mobile and narrow-viewport adaptation — one panel per screen with bottom tabs switching between the editor and LaTeX code, toolbar collapsed into a single horizontally scrollable row with >=44px touch targets, `min-height:0` fix so the code preview is no longer clipped off-screen, `100dvh` and 16px inputs so iOS no longer zooms the page on focus; LaTeX conversion and export logic unchanged
- **v2.0.1**: maintenance release, main.js unchanged; license moved from MIT to Apache-2.0; UI restyled with design tokens and a warm-white academic theme, toolbar buttons switched to plain text; added CI checks and automatic GitHub Pages demo deployment
- **v2.0.0**: repositioned as a general offline LaTeX light editor; added .tex import; verbatim preservation of unsupported structures for lossless round-trips; fixed preamble not being cached with drafts and formulas losing user edits
- **v1.1.0**: visual editor + formula assistant for math-modeling papers (removed in v2.0.0)
- **v1.0.0**: initial release

</details>

## Contributing

Issue reports and Pull Requests are welcome via the [Issue tracker](https://github.com/Escap1ng/VisualLaTeX/issues).

## License

[Apache License 2.0](./LICENSE) © Escap1ng

---

<div align="center">

**If this tool saved you an hour, consider leaving a Star**

</div>
