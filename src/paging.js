import { PAGE_SIZE } from './data.js';

export function pageRange(length, index = 0) {
  const start = Math.floor(Math.max(0, Math.min(index, Math.max(0, length - 1))) / PAGE_SIZE) * PAGE_SIZE;
  return { start, end: Math.min(start + PAGE_SIZE, length) };
}

export function discardPagedTree(root) {
  if (!root) return;
  // Descendants first: a parent's discard removes their DOM references.
  const pending = [root], mounted = [];
  while (pending.length) {
    const node = pending.pop();
    mounted.push(node);
    pending.push(...node.children);
  }
  for (const node of mounted) { node._cancelPage?.(); node._disposeViewport?.(); node._disposeBudget?.(); }
}

// Commit only the latest request; cancelled/replaced branches cannot reappear.
export function pagedChildren(node, container, source, path, render, changed, firstArrayOnly = false) {
  let mountedStart = -1, generation = 0, controller = null;
  let pending = null, pendingKey, pendingOffset;
  let releasePage = null;
  let pageRef = null;
  let retainedWanted = true;
  let compact = false, trimmed = false;
  const navButton = (text, disabled, offset) => {
    const button = document.createElement('button'); button.textContent = text; button.disabled = disabled;
    button.onclick = e => { e.stopPropagation(); show(undefined, offset); }; return button;
  };
  const show = (key, offset = Math.max(0, mountedStart)) => {
    if (pending && Object.is(key, pendingKey) && offset === pendingOffset) return pending;
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    pendingKey = key;
    pendingOffset = offset;
    node.setAttribute('aria-busy', 'true');
    if (mountedStart < 0) {
      const loading = document.createElement('div');
      loading.className = 'page-navigation';
      loading.textContent = '正在加载…';
      container.replaceChildren(loading);
    }
    pending = Promise.resolve().then(async () => {
      try {
        if (signal.aborted || request !== generation) return false;
        const page = await source.getChildren(path, { offset, key, firstArrayOnly, signal, all: source.paged === false && !compact });
        if (signal.aborted || request !== generation) return false;
        if (mountedStart === page.start && !trimmed) return true;
        const children = [];
        for (const [index, item] of page.items.entries()) {
          if(signal.aborted || request !== generation) return false;
          const child = render(item);
          if (child) child._pageKey = item.key;
          if (child) children.push(child);
          if(source.paged === false && page.items.length > 500 && index % 100 === 99) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if ((source.paged !== false || compact) && page.total > PAGE_SIZE) {
          const {start, end, total} = page;
          const navigation = document.createElement('div');
          navigation.className = 'page-navigation';
          const previous = navButton('上一页', start === 0, start - PAGE_SIZE);
          const label = document.createElement('span');
          label.textContent = `${start + 1}–${end} / ${total}`;
          const next = navButton('下一页', end >= total, end);
          navigation.append(previous, label, next);
          children.push(navigation);
        }
        if(page.limited){
          const hint = document.createElement('div'); hint.className = 'node-limit';
          hint.textContent = `节点较多，当前显示 ${page.start + 1}–${page.end} 项；可搜索定位其余内容。`;
          children.push(hint);
        }
        releasePage?.(); retainedWanted = true;
        pageRef = new WeakRef(page);
        releasePage = source.retainPage?.(path, page, { firstArrayOnly }) || null;
        for (const child of [...container.children]) discardPagedTree(child);
        container.replaceChildren(...children);
        mountedStart = page.start;
        trimmed = false;
        node._pageError = null;
        changed();
        source.prefetchChildren?.(path, page, { firstArrayOnly, signal });
        return true;
      } catch (error) {
        if (signal.aborted || request !== generation) return false;
        node._pageError = error.message || String(error);
        if (mountedStart < 0) {
          const message = document.createElement('div');
          message.className = 'page-navigation';
          message.textContent = '加载失败：' + node._pageError;
          const retry = document.createElement('button');
          retry.textContent = '重试';
          retry.onclick = e => { e.stopPropagation(); show(key, offset); };
          message.appendChild(retry);
          container.replaceChildren(message);
        } else {
          const navigation = container.children[container.children.length - 1];
          if (navigation?.className === 'page-navigation') {
            navigation.children[1].textContent = '加载失败，可再次翻页重试';
          }
        }
        changed();
        return false;
      } finally {
        if (request === generation) {
          pending = null;
          node.setAttribute('aria-busy', 'false');
        }
      }
    });
    return pending;
  };
  node._ensureChildren = show;
  node._trimChildren = selected => {
    generation++; controller?.abort(); pending = null;
    releasePage?.(); releasePage = null; pageRef = null;
    compact = true; trimmed = true;
    node.setAttribute('aria-busy', 'false');
    const kept = []; let run = [];
    const flush = () => {
      if (!run.length) return;
      const key = run[0]._pageKey;
      const hint = document.createElement('div'); hint.className = 'trimmed-range';
      const label = document.createElement('span'); label.textContent = `已精简 ${run.length} 项远处内容`;
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '查看此处';
      restore.onclick = e => { e.stopPropagation(); show(key); };
      hint.append(label, restore); kept.push(hint);
      for (const child of run) discardPagedTree(child);
      run = [];
    };
    for (const child of [...container.children]) {
      if (selected.has(child)) run.push(child);
      else { flush(); if (child.className !== 'node-limit') kept.push(child); }
    }
    flush(); container.replaceChildren(...kept);
  };
  node._setPageRetained = keep => {
    retainedWanted = keep;
    if(!keep){ releasePage?.(); releasePage = null; }
    else if(!releasePage){ const page = pageRef?.deref(); if(page) releasePage = source.retainPage?.(path, page, { firstArrayOnly }) || null; }
  };
  node._rememberPage = page => {
    if(page.start !== mountedStart) return;
    releasePage?.(); releasePage = null; pageRef = new WeakRef(page);
    if(retainedWanted) releasePage = source.retainPage?.(path, page, { firstArrayOnly }) || null;
  };
  node._cancelPage = () => {
    generation++;
    controller?.abort();
    pending = null;
    releasePage?.(); releasePage = null;
    pageRef = null;
    mountedStart = -1;
    node.setAttribute('aria-busy', 'false');
  };
  node._discardChildren = () => {
    node._cancelPage();
    for (const child of [...container.children]) discardPagedTree(child);
    container.replaceChildren();
    compact = false; trimmed = false;
  };
  return show;
}
