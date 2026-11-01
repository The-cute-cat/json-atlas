import test from 'node:test';
import assert from 'node:assert/strict';
import { isMacPlatform, shortcutLabel, shortcutAction } from '../src/shortcuts.js';

test('shortcut hints select the current platform and tolerate missing navigator fields', () => {
  assert(isMacPlatform({userAgentData:{platform:'macOS'},platform:'Win32'}));
  assert(isMacPlatform({platform:'MacIntel'}));
  assert(!isMacPlatform({platform:'Win32'}));
  assert(!isMacPlatform({}));
  assert.equal(shortcutLabel('save',true),'⌘+S');
  assert.equal(shortcutLabel('save',false),'Ctrl+S');
  assert.equal(shortcutLabel('settings',true),'⌘+,');
  assert.equal(shortcutLabel('settings',false),'Ctrl+Alt+S');
  assert.equal(shortcutLabel('nextFile',true),'⌘+Shift+]');
});

test('IDEA actions use exact modifiers and physical keys without stealing AltGraph or IME input', () => {
  assert.equal(shortcutAction({key:'l',ctrlKey:true,altKey:true},false),'format');
  assert.equal(shortcutAction({key:'¬',code:'KeyL',metaKey:true,altKey:true},true),'format');
  assert.equal(shortcutAction({key:'l',ctrlKey:true,altKey:true},true),null);
  assert.equal(shortcutAction({key:'s',ctrlKey:true,altKey:true},false),'settings');
  assert.equal(shortcutAction({key:'s',ctrlKey:true,altKey:true,getModifierState:()=>true},false),null);
  assert.equal(shortcutAction({key:'l',ctrlKey:true,altKey:true,isComposing:true},false),null);
  assert.equal(shortcutAction({key:'l',ctrlKey:true,altKey:true,repeat:true},false),null);
  assert.equal(shortcutAction({key:'+',code:'NumpadAdd',ctrlKey:true,shiftKey:true},false),'expandAll');
  assert.equal(shortcutAction({key:'-',code:'NumpadSubtract',ctrlKey:true,shiftKey:true},false),'collapseAll');
  assert.equal(shortcutAction({key:'ArrowRight',altKey:true},false),'nextFile');
  assert.equal(shortcutAction({key:'}',code:'BracketRight',metaKey:true,shiftKey:true},true),'nextFile');
  assert.equal(shortcutAction({key:'ArrowRight',altKey:true},true),null);
  assert.equal(shortcutAction({key:'F3',shiftKey:true},false),'previousMatch');
});

test('custom menu shortcuts work on both platforms without AltGr or composition conflicts', () => {
  for(const mac of [false,true]) {
    const mod = mac ? {metaKey:true} : {ctrlKey:true};
    for(const [key,code,action] of [['v','KeyV','switchView'],['e','KeyE','editMode'],['0','Digit0','resetView']]) {
      assert.equal(shortcutAction({...mod,altKey:true,key,code},mac),action);
      assert.equal(shortcutAction({...mod,altKey:true,key,code,isComposing:true},mac),null);
      assert.equal(shortcutAction({...mod,altKey:true,key,code,getModifierState:()=>true},mac),null);
    }
    assert.equal(shortcutAction({key:'F1'},mac),'about');
    assert.equal(shortcutLabel('switchView',mac),mac?'⌘+⌥+V':'Ctrl+Alt+V');
  }
  assert.equal(shortcutAction({key:'√',code:'KeyV',metaKey:true,altKey:true},true),'switchView');
});
