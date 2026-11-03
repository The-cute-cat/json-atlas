export function isMacPlatform(platform = globalThis.navigator) {
  return /mac|iphone|ipad|ipod/i.test(platform?.userAgentData?.platform || platform?.platform || platform?.userAgent || '');
}

// Physical key codes keep Option+letter shortcuts usable on macOS layouts.
const bindings = {
  open: ['Mod', 'O'], save: ['Mod', 'S'], saveCopy: ['Mod', 'Shift', 'S'],
  find: ['Mod', 'F'], undo: ['Mod', 'Z'], copyNode: ['Mod', 'C'], format: ['Mod', 'Alt', 'L'],
  settings: ['Ctrl', 'Alt', 'S'], close: ['Ctrl', 'F4'],
  switchView: ['Mod', 'Alt', 'V'], editMode: ['Mod', 'Alt', 'E'], resetView: ['Mod', 'Alt', '0'], about: ['F1'],
  expandAll: ['Mod', 'Shift', 'NumpadAdd'], collapseAll: ['Mod', 'Shift', 'NumpadSubtract'],
  nextFile: ['Alt', 'ArrowRight'], previousFile: ['Alt', 'ArrowLeft'],
  nextMatch: ['F3'], previousMatch: ['Shift', 'F3']
};
const macBindings = {
  settings: ['Meta', ','], close: ['Meta', 'W'],
  nextFile: ['Meta', 'Shift', ']'], previousFile: ['Meta', 'Shift', '['],
  nextMatch: ['Meta', 'G'], previousMatch: ['Meta', 'Shift', 'G']
};
const keysFor = (action, mac) => (mac && macBindings[action]) || bindings[action];

export function shortcutLabel(action, mac = isMacPlatform()) {
  const names = { Mod: mac ? '⌘' : 'Ctrl', Meta: '⌘', Ctrl: 'Ctrl', Alt: mac ? '⌥' : 'Alt',
    ArrowRight: '→', ArrowLeft: '←', NumpadAdd: '小键盘 +', NumpadSubtract: '小键盘 −' };
  return keysFor(action, mac).map(key => names[key] || key).join('+');
}

export function shortcutAction(event, mac = isMacPlatform()) {
  if(event.isComposing || event.repeat || event.getModifierState?.('AltGraph')) return null;
  for(const action of Object.keys(bindings)) {
    const keys = keysFor(action, mac).map(key => key === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : key);
    if(!!event.ctrlKey !== keys.includes('Ctrl') || !!event.metaKey !== keys.includes('Meta') ||
      !!event.altKey !== keys.includes('Alt') || !!event.shiftKey !== keys.includes('Shift')) continue;
    const key = keys.at(-1);
    const code = key.length === 1 && /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key :
      ({',':'Comma', '[':'BracketLeft', ']':'BracketRight'})[key] || key;
    if(event.code === code || String(event.key).toLowerCase() === key.toLowerCase()) return action;
  }
  return null;
}
