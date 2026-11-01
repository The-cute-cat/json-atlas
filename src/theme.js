export const normalizeTheme = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';

export function watchTheme(root, media, preference = 'system', onChange) {
  let selected = normalizeTheme(preference);
  const apply = () => {
    const resolved = selected === 'system' ? (media?.matches ? 'dark' : 'light') : selected;
    if(root) { root.dataset.theme = resolved; root.style.colorScheme = resolved; }
    onChange?.(resolved, selected);
    return resolved;
  };
  media?.addEventListener?.('change', apply);
  apply();
  return value => { selected = normalizeTheme(value); return apply(); };
}
