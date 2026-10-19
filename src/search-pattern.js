const WORD = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const pathInside = (path, scope) => !scope || scope.length <= path.length && scope.every((key, i) => key === path[i]);
const ASCII_CLASSES = { d: '[0-9]', D: '[^0-9]', w: '[A-Za-z0-9_]', W: '[^A-Za-z0-9_]',
  s: '[\\t\\n\\v\\f\\r \\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}]' };
ASCII_CLASSES.S = '[^' + ASCII_CLASSES.s.slice(1);

// Normalize the common JS/Rust syntax once, before crossing the native bridge.
// Assertions and backreferences that require backtracking are deliberately rejected.
function nativeRegex(source) {
  let out = '', inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const next = source[++i];
      if (/[1-9k]/.test(next)) throw new Error('正则暂不支持反向引用');
      if (ASCII_CLASSES[next]) out += ASCII_CLASSES[next];
      else if (next === 'b') out += inClass ? '\\x08' : '(?-u:\\b)';
      else if (next === 'B') out += '(?-u:\\B)';
      else if (next === '0') out += '\\x00';
      else if (next === 'c') out += '\\x' + (source.charCodeAt(++i) % 32).toString(16).padStart(2, '0');
      else if (next === 'u' && source[i+1] !== '{') {
        let code = parseInt(source.slice(i+1, i+5), 16); i += 4;
        if (code >= 0xd800 && code <= 0xdbff && source.slice(i+1, i+3) === '\\u') {
          const low = parseInt(source.slice(i+3, i+7), 16);
          if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code-0xd800)<<10) + low-0xdc00; i += 6; }
        }
        if (code >= 0xd800 && code <= 0xdfff) throw new Error('正则不支持孤立的 Unicode 代理字符');
        out += '\\u{' + code.toString(16) + '}';
      } else out += '\\' + next;
    } else if (c === '[' && !inClass && source[i+1] === ']') { out += '[a&&b]'; i++; }
    else if (c === '[' && !inClass && source.slice(i+1, i+3) === '^]') { out += '(?s:.)'; i += 2; }
    else if (c === '[') { out += inClass ? '\\[' : '['; inClass = true; }
    else if (c === ']') { out += ']'; inClass = false; }
    else if (inClass && (c === '&' || c === '~' || c === '-' && (source[i-1] === '-' || source[i+1] === '-'))) out += '\\' + c;
    else if (!inClass && c === '.') out += '[^\\n\\r\\u{2028}\\u{2029}]';
    else if (!inClass && c === '(' && /^(?:\?=|\?!|\?<=|\?<!)/.test(source.slice(i+1))) throw new Error('正则暂不支持环视，可使用分组、字符组、重复和锚点');
    else out += c;
  }
  return out;
}

export function compileSearch(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (query.length > 32768) throw new Error('搜索内容过长，请缩短后重试');
  if (!regex && !wholeWord) {
    const needle = caseSensitive ? query : query.toLowerCase();
    return { test: text => (caseSensitive ? text : text.toLowerCase()).includes(needle),
      nativePattern: caseSensitive ? escape(query) : null, caseSensitive };
  }
  let expression;
  try { expression = new RegExp(regex ? query : escape(query), caseSensitive ? 'u' : 'iu'); }
  catch (error) { throw new Error('正则表达式无效：' + error.message); }
  let nativePattern = nativeRegex(expression.source);
  if (wholeWord) {
    expression = new RegExp(`(?<!${WORD})(?:${expression.source})(?!${WORD})`, caseSensitive ? 'u' : 'iu');
    nativePattern = `\\b{start-half}(?:${nativePattern})\\b{end-half}`;
  }
  return { test: text => expression.test(text), nativePattern, caseSensitive };
}
