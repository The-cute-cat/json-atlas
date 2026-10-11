import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export const desktop = isTauri();
export const readNativeFile = path => invoke('read_document', { path });
export const selectNativeFiles = () => invoke('select_documents');
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
