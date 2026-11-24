# Reading large files in JSON Atlas

Use the Windows desktop edition for large JSON, JSONL, NDJSON, or JSON Lines files. Open a local copy if the source is on a network share.

## Choose a file size threshold

Open **View → Settings…** (`查看 → 设置…`), then choose **Performance and memory → Large-file threshold** (`性能与内存 → 大文件处理阈值`). The default is 64 MB. You can choose 32, 64, 128, or 256 MB. The app measures these values in binary units, so 1 MB in the setting equals 1,048,576 bytes. A change applies the next time you open a file.

| File size | Desktop | Browser |
| --- | --- | --- |
| At or below the threshold | Parses the file in memory | Parses the file in memory |
| Above the threshold | Builds a disk index and opens a read-only tree | Asks you to use the desktop app |

Lower the threshold if parsing in memory makes your device sluggish. Indexed files open in tree view and can be browsed and searched in pages.

## Open and reopen an indexed file

The first open scans the file and creates an index in the app's local cache. Wait for both scanning and finalization to finish before browsing. The status changes as the app prepares the index for reading.

Under **Performance and memory → Large-file index rebuild** (`性能与内存 → 大文件索引重建`), **Smart rebuild** (`智能重建`) can reuse a saved index across restarts and verify it against the file in the background. The app rebuilds when the file size changes, the saved hash is missing, or verification finds a mismatch. Select **Always rebuild** (`始终重建`) to scan the source each time you open it.

## Browse and search

- Expand a branch to load up to 100 entries at a time. Use its paging controls to reach later entries.
- Search by key or value. Select a node and enable the scope button to limit the search to that branch. The result list shows up to 1,000 matches.
- Long fields start with a preview. A single full-text read or copy has an 8 MiB limit.
- Indexed JSON supports up to 128 levels of nesting and keys up to 64 KiB. Indexed files are read-only.

## Manage memory with multiple files open

**Settings → Performance and memory** (`设置 → 性能与内存`) shows loaded files and the estimated size of cached index pages. The page estimate covers the front-end page cache. An indexed file can appear here before opening a branch fills that cache.

Use **Release background files** (`释放后台文件`) to unload inactive files. You can also set an idle timeout or a simultaneous file limit. Tabs stay available and reload when selected. The active file and files with edits or undo history stay loaded, so the limit can be temporarily exceeded.

When **Reopen files on restart** (`文件与恢复 → 重启时重新打开文件`) is enabled, **Low-memory mode** (`小内存模式`) initially loads only the last active file. Open other restored tabs by selecting them.
