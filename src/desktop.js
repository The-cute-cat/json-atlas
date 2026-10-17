import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { IndexedDataSource } from './large-files.js';

export const desktop = isTauri();
export const readNativeFile = path => invoke('read_document', { path });
export const selectNativeFiles = () => invoke('select_documents');
const indexRequest = (op, id, args = {}, path = null) => invoke('indexed_document', { op, id, args, path })
  .catch(error => { throw error instanceof Error ? error : new Error(String(error)); });
export const statNativeFile = path => indexRequest('stat', crypto.randomUUID(), {}, path);
export async function openIndexedFile(file, { signal, progress, wrap, strict }) {
  const id = crypto.randomUUID();
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
    opening = indexRequest('open', id, { wrap, strict }, file.path);
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
      if (paths.length) await openPaths(paths);
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
