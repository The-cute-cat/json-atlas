export function isMacPlatform(platform = globalThis.navigator) {
  return /mac|iphone|ipad|ipod/i.test(platform?.userAgentData?.platform || platform?.platform || platform?.userAgent || '');
}

// Physical key codes keep Option+letter shortcuts usable on macOS layouts.
const bindings = {
  newDocument: ['Mod', 'N'], open: ['Mod', 'O'], save: ['Mod', 'S'], saveCopy: ['Mod', 'Shift', 'S'],
  find: ['Mod', 'F'], undo: ['Mod', 'Z'], redo: ['Mod', 'Shift', 'Z'], copyNode: ['Mod', 'C'], format: ['Mod', 'Alt', 'L'],
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
const nonMacAlternatives = {
  redo: ['Ctrl', 'Y'],
  switchView: ['Ctrl', 'Shift', 'F6'],
  editMode: ['Ctrl', 'Shift', 'E']
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
    const primary = keysFor(action, mac).map(key => key === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : key);
    const alternative = !mac && nonMacAlternatives[action];
    if(matchesShortcut(event, primary) || (alternative && matchesShortcut(event, alternative))) return action;
  }
  return null;
}

function matchesShortcut(event, keys) {
  if(!!event.ctrlKey !== keys.includes('Ctrl') || !!event.metaKey !== keys.includes('Meta') ||
    !!event.altKey !== keys.includes('Alt') || !!event.shiftKey !== keys.includes('Shift')) return false;
  const key = keys.at(-1);
  const code = /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key :
    ({',':'Comma', '[':'BracketLeft', ']':'BracketRight'})[key] || key;
  const numpadSymbol = {NumpadAdd:'+', NumpadSubtract:'-'}[key];
  return event.code === code || String(event.key).toLowerCase() === key.toLowerCase()
    || (event.location === 3 && numpadSymbol !== undefined && event.key === numpadSymbol);
}

export function shortcutAlternativeLabel(action, mac = isMacPlatform()) {
  return mac ? '' : nonMacAlternatives[action]?.join('+') || '';
}
