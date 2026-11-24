import english from './locales/en.json' with { type: 'json' };

const LANGUAGE_KEY = 'json-atlas_language_v1';
const DEFAULT_LANGUAGE = 'en';
let language = DEFAULT_LANGUAGE;

export function normalizeLanguage(value) {
  return value === 'zh-CN' ? 'zh-CN' : DEFAULT_LANGUAGE;
}

export function getLanguage() {
  return language;
}

export function setLanguage(value) {
  language = normalizeLanguage(value);
}

export function saveLanguage(value, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(LANGUAGE_KEY, normalizeLanguage(value));
    return true;
  } catch {
    return false;
  }
}

export function t(source, ...values) {
  const translation = language === 'en' && Object.hasOwn(english, source) ? english[source] : source;
  if (!values.length) return translation;
  let index = 0;
  return translation.replaceAll('{}', () => String(values[index++]));
}

export function nativeErrorMessage(error) {
  if (language === 'zh-CN' && typeof error?.messageZhCn === 'string') return error.messageZhCn;
  return typeof error?.message === 'string' ? error.message : String(error);
}

export function msg(parts, ...values) {
  return t(parts.join('{}'), ...values);
}

function detectLanguage(localeSource) {
  const preferences = localeSource?.languages?.length ? localeSource.languages : [localeSource?.language];
  for (const preference of preferences) {
    try {
      const locale = new Intl.Locale(preference);
      if (locale.language === 'en') return 'en';
      if (locale.language === 'zh' && locale.maximize().script === 'Hans') return 'zh-CN';
    } catch { /* Ignore unavailable or malformed locale tags. */ }
  }
  return DEFAULT_LANGUAGE;
}

// Translate the bundled shell before the reader creates user data or saves DOM references.
export function initializeLanguage(document, storage, localeSource = globalThis.navigator) {
  let preference;
  try {
    storage ??= globalThis.localStorage;
    preference = storage.getItem(LANGUAGE_KEY);
    if (preference !== 'en' && preference !== 'zh-CN') {
      preference = detectLanguage(localeSource);
      saveLanguage(preference, storage);
    }
  } catch { preference = detectLanguage(localeSource); }
  setLanguage(preference);
  document.documentElement.lang = language;
  if (language !== 'en') return;

  const translateText = value => {
    const text = value.trim();
    return text ? value.replace(text, () => t(text)) : value;
  };
  const walker = document.createTreeWalker(document.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement.closest('script, style')) node.nodeValue = translateText(node.nodeValue);
  }
  for (const element of document.querySelectorAll('[title], [aria-label], [placeholder], [alt], meta[name="description"]')) {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'content']) {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, t(element.getAttribute(attribute)));
    }
  }
}
