import { PAGE_SIZE } from './data.js';

export function pageRange(length, index = 0) {
  const start = Math.floor(Math.max(0, Math.min(index, Math.max(0, length - 1))) / PAGE_SIZE) * PAGE_SIZE;
  return { start, end: Math.min(start + PAGE_SIZE, length) };
}

// Each branch keeps one page mounted, including very wide objects.
export function pagedChildren(node, container, value, render, changed, firstArrayOnly = false) {
  const array = Array.isArray(value);
  const keys = array ? null : Object.keys(value);
  const length = array ? (firstArrayOnly ? Math.min(value.length, 1) : value.length) : keys.length;
  let mountedStart = -1;
  const show = (key) => {
    const index = key === undefined ? Math.max(0, mountedStart) : array ? Number(key) : keys.indexOf(String(key));
    const { start, end } = pageRange(length, index);
    if (mountedStart === start) return;
    mountedStart = start;
    container.replaceChildren();
    for (let i = start; i < end; i++) {
      const childKey = array ? i : keys[i];
      const child = render(childKey, value[childKey], array);
      if (child) container.appendChild(child);
    }
    if (length > PAGE_SIZE) {
      const navigation = document.createElement('div');
      navigation.className = 'page-navigation';
      const previous = document.createElement('button');
      previous.textContent = '上一页';
      previous.disabled = start === 0;
      previous.onclick = e => { e.stopPropagation(); show(array ? start - PAGE_SIZE : keys[start - PAGE_SIZE]); changed(); };
      const label = document.createElement('span');
      label.textContent = `${start + 1}–${end} / ${length}`;
      const next = document.createElement('button');
      next.textContent = '下一页';
      next.disabled = end >= length;
      next.onclick = e => { e.stopPropagation(); show(array ? end : keys[end]); changed(); };
      navigation.append(previous, label, next);
      container.appendChild(navigation);
    }
  };
  node._ensureChildren = show;
  node._discardChildren = () => { mountedStart = -1; container.replaceChildren(); };
  return show;
}
