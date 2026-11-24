import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getLanguage, nativeErrorMessage } from './i18n.js';
import { IndexedDataSource } from './large-files.js';

export const desktop = isTauri();
let themeUpdate = Promise.resolve();
export function updateWindowTheme(theme, resolved) {
  if(!desktop) return;
  themeUpdate = themeUpdate.then(async () => {
    // MenuTheme::Auto consults the process UX preference while repainting.
    // Set that preference first, before Tauri schedules the menu repaint.
    await invoke('sync_menu_theme', { dark:resolved === 'dark' });
    await getCurrentWebviewWindow().setTheme(theme === 'system' ? null : theme);
  }).catch(console.error);
}
let menuUpdate = Promise.resolve();
let menuLanguageSet = false;
export function updateDocumentMenu(items) {
  if(!desktop) return;
  menuUpdate = menuUpdate.then(async () => {
    if (!menuLanguageSet && getLanguage() === 'en') {
      try {
        await invoke('use_english_menu');
        menuLanguageSet = true;
      } catch (error) {
        console.error(error);
      }
    }
    await invoke('sync_document_menu', { items });
  }).catch(console.error);
}
function invokeDocument(command, args) {
  return invoke(command, args).catch(error => {
    throw new Error(nativeErrorMessage(error), { cause: error });
  });
}
export const readNativeFile = (path, maxBytes) => invokeDocument('read_document', { path, maxBytes });
export const selectNativeFiles = () => invokeDocument('select_documents');
export const openReleasePage = () => invoke('open_release_page');
export const saveDocumentCopy = (name, text, originalPath, protectedPaths = []) => invokeDocument('save_document_copy', { name, text, originalPath, protectedPaths });
export const saveNativeDocument = (path, text, expectedText) => invokeDocument('save_document', { path, text, expectedText });
export async function guardEditedClose(hasChanges, confirmDiscard, saveSession) {
  await getCurrentWebviewWindow().onCloseRequested(async event => {
    saveSession();
    if (!hasChanges()) return;
    event.preventDefault();
    if (await confirmDiscard()) await getCurrentWebviewWindow().destroy();
  });
}
const indexRequest = (op, id, args = {}, path = null) => invokeDocument('indexed_document', { op, id, args, path });
// Unlike randomUUID, getRandomValues is available even on a custom WebView scheme.
const indexId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, '0')).join('');
export const statNativeFile = path => indexRequest('stat', indexId(), {}, path);
export async function openIndexedFile(file, { signal, progress = () => {}, wrap, strict, reuse = true }) {
  const id = indexId();
  signal.throwIfAborted();
  const unlisten = await listen('index-progress', event => {
    if (event.payload.id !== id) return;
    // Retry after the first checkpoint if cancellation raced job registration.
    if (signal.aborted) indexRequest('cancel', id).catch(console.error);
    else progress(event.payload.bytes);
  });
  const cancel = () => indexRequest('cancel', id).catch(console.error);
  // Invoke open first: the native command registers cancellation before working.
  let opening;
  try {
    signal.throwIfAborted();
    opening = indexRequest('open', id, { wrap, strict, reuse }, file.path);
    signal.addEventListener('abort', cancel, { once: true });
    const info = await opening;
    if (signal.aborted) { await indexRequest('close', id); signal.throwIfAborted(); }
    return new IndexedDataSource(indexRequest, id, info, wrap);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    throw error;
  } finally { unlisten(); signal.removeEventListener('abort', cancel); }
}
export function updateWindowTitle(name) {
  if (desktop) invoke('set_document_title', { name: name || null }).catch(console.error);
}

export async function connectDesktop(openPaths, reportError, onAction) {
  if (!desktop) return;
  // Listen before draining: requests arriving during frontend startup remain queued.
  let queue = Promise.resolve();
  const drain = () => {
    queue = queue.then(async () => {
      const paths = await invoke('take_open_requests');
      if (paths.length) openPaths(paths).catch(reportError);
    }).catch(reportError);
    return queue;
  };
  await listen('open-files-pending', drain);
  await listen('desktop-action', event => onAction?.(event.payload));
  await getCurrentWebviewWindow().onDragDropEvent(event => {
    if (event.payload.type === 'drop') openPaths(event.payload.paths).catch(reportError);
  });
  await drain();
}
