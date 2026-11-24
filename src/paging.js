import { msg, t } from './i18n.js';
import { MAX_RENDERED_CHILDREN, PAGE_SIZE } from './data.js';

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
export function pagedChildren(node, container, source, path, render, changed, firstArrayOnly = false, onNavigate) {
  let mountedStart = -1, generation = 0, controller = null;
  let pending = null, pendingKey, pendingOffset;
  let releasePage = null;
  let pageRef = null;
  let retainedWanted = true;
  let compact = false, trimmed = false;
  const navButton = (text, disabled, offset) => {
    const button = document.createElement('button'); button.textContent = text; button.disabled = disabled;
    button.onclick = async e => {
      e.stopPropagation();
      if(await show(undefined, offset)) onNavigate?.(container.children[0]);
    };
    return button;
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
      loading.textContent = t('正在加载…');
      container.replaceChildren(loading);
    }
    pending = Promise.resolve().then(async () => {
      try {
        if (signal.aborted || request !== generation) return false;
        // Disk-backed sources and reclaimed branches keep their smaller I/O pages.
        const limit = source.paged === false && !compact ? MAX_RENDERED_CHILDREN : PAGE_SIZE;
        const page = await source.getChildren(path, { offset, key, firstArrayOnly, signal, limit });
        if (signal.aborted || request !== generation) return false;
        if (mountedStart === page.start && !trimmed) {
          if (node._pageError) {
            node._pageError = null;
            const navigation = container.children[container.children.length - 1];
            if (navigation?.className === 'page-navigation') navigation.children[1].textContent = `${page.start + 1}–${page.end} / ${page.total}`;
            changed();
          }
          return true;
        }
        const children = [];
        for (const [index, item] of page.items.entries()) {
          if(signal.aborted || request !== generation) return false;
          const child = render(item);
          if (child) child._pageKey = item.key;
          if (child) children.push(child);
          if(source.paged === false && page.items.length > 500 && index % 100 === 99) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (page.total > limit) {
          const {start, end, total} = page;
          const navigation = document.createElement('div');
          navigation.className = 'page-navigation';
          const previous = navButton(t('上一页'), start === 0, start - limit);
          const label = document.createElement('span');
          label.textContent = `${start + 1}–${end} / ${total}`;
          const next = navButton(t('加载更多'), end >= total, end);
          navigation.append(previous, label, next);
          children.push(navigation);
        }
        releasePage?.(); retainedWanted = true;
        pageRef = new WeakRef(page);
        releasePage = source.retainPage?.(path, page, { firstArrayOnly }) || null;
        for (const child of [...container.children]) discardPagedTree(child);
        container.replaceChildren(...children);
        mountedStart = page.start;
        node._pageStart = page.start;
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
          message.textContent = t('加载失败：') + node._pageError;
          const retry = document.createElement('button');
          retry.textContent = t('重试');
          retry.onclick = e => { e.stopPropagation(); show(key, offset); };
          message.appendChild(retry);
          container.replaceChildren(message);
        } else {
          const navigation = container.children[container.children.length - 1];
          if (navigation?.className === 'page-navigation') {
            navigation.children[1].textContent = t('加载失败，可再次翻页重试');
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
      const label = document.createElement('span'); label.textContent = msg`已精简 ${run.length} 项远处内容`;
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = t('查看此处');
      restore.onclick = e => { e.stopPropagation(); show(key); };
      hint.append(label, restore); kept.push(hint);
      for (const child of run) discardPagedTree(child);
      run = [];
    };
    for (const child of [...container.children]) {
      if (selected.has(child)) run.push(child);
      else { flush(); kept.push(child); }
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
    node._pageStart = undefined;
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
