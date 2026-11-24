import { setLanguage, t } from './i18n.js';
import { parseDocument, MAX_FILE_BYTES } from './data.js';

self.onmessage = async ({ data }) => {
  setLanguage(data.language);
  try {
    if (data.size > MAX_FILE_BYTES) throw new Error(t('当前版本支持最大 256 MiB 的文件'));
    let text;
    if(data.file) text = await data.file.text();
    else {
      try { text = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(data.bytes); }
      catch { throw new Error(t('文件不是有效 UTF-8')); }
    }
    self.postMessage({ result: parseDocument(text, data.name), text: data.keepText ? text : null });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
