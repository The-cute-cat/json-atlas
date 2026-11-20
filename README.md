# JSON Atlas

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [Español](docs/README.es.md) · [Français](docs/README.fr.md)

**Explore JSON and JSONL one level at a time on an interactive tree canvas.**

JSON Atlas is a free, open-source reader and editor for local JSON, JSONL, and NDJSON files. Expand nested data, find fields by key or value, and use the IDE view to edit the source. The app parses, indexes, and searches file contents locally.

[![Release](https://img.shields.io/github/v/release/The-cute-cat/json-atlas?label=release)](https://github.com/The-cute-cat/json-atlas/releases)
[![CI](https://github.com/The-cute-cat/json-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/The-cute-cat/json-atlas/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Project site](https://the-cute-cat.github.io/json-atlas/) · [Try in your browser](https://the-cute-cat.github.io/json-atlas/app.html) · [Download for Windows](https://github.com/The-cute-cat/json-atlas/releases/latest) · [Report an issue](https://github.com/The-cute-cat/json-atlas/issues)

![A sample API response on the JSON Atlas tree canvas](assets/screenshots/hero.png)

## Install

| Edition | Requirements and setup |
| --- | --- |
| Windows desktop | Windows 10 or 11 (64-bit) and Microsoft Edge WebView2. Choose the EXE or MSI installer from [Releases](https://github.com/The-cute-cat/json-atlas/releases). A portable package is also available and requires WebView2. |
| Browser | Open the [browser app](https://the-cute-cat.github.io/json-atlas/app.html). The standalone HTML version can run offline. Saving downloads an edited copy. |
| macOS preview | Apple silicon and macOS 15 or later. Sign in to GitHub and download the artifact from a successful [preview workflow run](https://github.com/The-cute-cat/json-atlas/actions/workflows/macos-preview.yml). Open the DMG and drag the app into Applications. Gatekeeper may block the preview because it is not notarized. |

The Windows installers can associate `.json`, `.jsonl`, `.ndjson`, and `.jsonlines` files. The EXE installer offers a choice, while the MSI registers these types. To switch from EXE to MSI, uninstall the EXE installation first. MSI uninstallation clears the current user's app settings, reading history, and cache. Upgrades retain those files. JSON and JSONL files outside the app's data directories are outside the cleanup scope.

By default, the desktop app checks GitHub Releases daily. You can check manually or turn off automatic checks from **Check for updates**.

## Quick start

1. Drop a file onto the app or open it with Ctrl/⌘+O. JSONL opens directly as one record per line.
2. Click a node's arrow to expand it. Drag the background or scroll to pan. Hold Ctrl/⌘ while scrolling to zoom.
3. Press Ctrl/⌘+F for advanced search. Switch between open files in the sidebar. The desktop app distinguishes same-named files by their full local paths.
4. Press Ctrl/⌘+N to create a blank JSON document. Select an object or array and click **+** to add a child or an array item. Applied edits in newly created documents are saved as drafts and can be restored after restart. Saving or explicitly discarding a draft clears it.

Paste JSON or JSONL onto the canvas with Ctrl/⌘+V to open a temporary document. Its first successful desktop save gives it a path. Unsaved pasted documents are excluded from desktop restart recovery. The desktop app accepts local paths. Copy files from UNC shares or mapped network drives to local storage before opening them.

## Tree and IDE editing

- In the tree, right-click a node to copy its content or path, edit its value, or hide it from the view. Enter strings directly and use valid JSON for numbers, booleans, `null`, objects, and arrays.
- Templates can reuse visibility rules and expansion state. Hidden fields are excluded from tree search. Strings that contain JSON can open as virtual subtrees. Those virtual nodes are read-only.
- Switch to the IDE view for syntax highlighting, line numbers, code folding, and source editing. Search expands folded matches. Correct syntax errors before saving or switching back to the tree.
- Undo history keeps the ten most recent steps and groups consecutive IDE typing. Undo and redo work across the tree and IDE views.
- On desktop, save to the original file or choose **Save As**. If the original changed on disk, save the working copy separately. When tree editing JSONL, only valid records are exported. Use **Save As** to retain skipped lines in the original.

## Search and large files

Quick search is available on the toolbar. Advanced search can match case, find whole words, use regular expressions, and restrict a query to the selected branch. Regular expressions support groups, character classes, repetition, anchors, and Unicode properties. Lookaround and backreferences are unsupported. Tree search displays up to 1,000 matches.

Set the large-file threshold to 32, 64, 128, or 256 MB in **Reading and Layout**. The default is 64 MB, and 1 MB equals 1,048,576 bytes. Below or at the threshold, files are parsed in memory. Above it, the desktop app creates a temporary disk index and reads branches in pages of 100 items. The indexed tree is read-only. The browser app declines files above the threshold.

The tree limits expansion to around 5,000 displayed nodes. A single full-value read or copy is limited to 8 MiB. Disk indexing supports up to 128 levels of JSON nesting and field names up to 64 KiB. Settings also control IDE limits on structure and text size for in-memory files.

## Shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| New / Open | Ctrl+N / Ctrl+O | ⌘+N / ⌘+O |
| Save / Save As | Ctrl+S / Ctrl+Shift+S | ⌘+S / ⌘+Shift+S |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | ⌘+Z / ⌘+Shift+Z |
| Find | Ctrl+F | ⌘+F |
| Next / Previous match | F3 / Shift+F3 | ⌘+G / ⌘+Shift+G |
| Format document | Ctrl+Alt+L | ⌘+⌥+L |
| Switch tree / IDE view | Ctrl+Alt+V or Ctrl+Shift+F6 | ⌘+⌥+V |

See **Settings → Keyboard Shortcuts** for the complete list.

## Development and license

Run `npm ci` followed by `npm run dev` for browser development. For desktop development, use `npm run desktop:dev` after installing the prerequisites in the [contribution guide](CONTRIBUTING.md). Use `npm run build:single` to build the standalone HTML app and `npm run build:site` to build the project site.

See [Releases](https://github.com/The-cute-cat/json-atlas/releases) for published builds and the [changelog](CHANGELOG.md) for changes. JSON Atlas is licensed under [Apache-2.0](LICENSE). Copyright © 2026 The_cute_cat and contributors.
