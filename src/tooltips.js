// Native title balloons do not inherit the application's theme. Migrate titles
// as they enter the document, retaining a text-only, keyboard-accessible hint.
export function installTooltips(document, window) {
  if(!document.body?.appendChild || !document.querySelectorAll) return;
  const tip = document.createElement('div');
  tip.id = 'appTooltip'; tip.className = 'app-tooltip'; tip.hidden = true;
  tip.setAttribute('role','tooltip'); document.body.appendChild(tip);
  let target = null, timer, describedBy;
  const migrateTitle = element => {
    if(element.nodeType !== 1) return;
    if(element.hasAttribute('title')) {
      const title = element.getAttribute('title');
      if(title) element.dataset.tooltip = title; else delete element.dataset.tooltip;
      element.removeAttribute('title');
    }
  };
  const migrate = element => {
    if(element.nodeType !== 1) return;
    migrateTitle(element);
    for(const child of element.querySelectorAll('[title]')) migrateTitle(child);
  };
  migrate(document.body);
  const hide = () => {
    window.clearTimeout(timer); tip.hidden = true;
    if(target) {
      if(describedBy === null) target.removeAttribute('aria-describedby');
      else if(describedBy !== undefined) target.setAttribute('aria-describedby',describedBy);
    }
    target = null; describedBy = undefined;
  };
  const show = element => {
    if(element === target) return;
    hide();
    if(!element?.dataset.tooltip) return;
    target = element; describedBy = target.getAttribute('aria-describedby');
    timer = window.setTimeout(() => {
      if(!target?.isConnected || !target.dataset.tooltip) { hide(); return; }
      tip.textContent = target.dataset.tooltip;
      (target.closest('dialog[open]') || document.body).appendChild(tip);
      tip.hidden = false;
      target.setAttribute('aria-describedby', [describedBy,tip.id].filter(Boolean).join(' '));
      const anchor = target.getBoundingClientRect(), rect = tip.getBoundingClientRect();
      tip.style.left = `${Math.max(8,Math.min(anchor.left,window.innerWidth - rect.width - 8))}px`;
      const below = anchor.bottom + 8;
      tip.style.top = `${Math.max(8,Math.min(below + rect.height > window.innerHeight - 8 ? anchor.top - rect.height - 8 : below,window.innerHeight - rect.height - 8))}px`;
    },450);
  };
  const enter = event => {
    const element = event.target.closest?.('[title],[data-tooltip]');
    if(element?.hasAttribute('title')) migrate(element);
    show(element);
  };
  const leave = event => { if(target && !target.contains(event.relatedTarget)) hide(); };
  document.addEventListener('pointerover',enter);
  document.addEventListener('pointerout',leave);
  document.addEventListener('focusin',enter);
  document.addEventListener('focusout',leave);
  document.addEventListener('pointerdown',hide,true);
  document.addEventListener('keydown',hide,true);
  document.addEventListener('scroll',hide,true);
  document.addEventListener('close',hide,true);
  window.addEventListener('resize',hide);
  window.addEventListener('blur',hide);
  if(window.MutationObserver) new window.MutationObserver(records => {
    for(const record of records) {
      if(record.type === 'attributes') {
        migrateTitle(record.target);
        if(record.target === target && !tip.hidden) tip.textContent = target.dataset.tooltip || '';
      }
      else for(const node of record.addedNodes) migrate(node);
    }
    if(target && (!target.isConnected || !target.dataset.tooltip)) hide();
  }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['title']});
}
