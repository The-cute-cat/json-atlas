import { parseDocument, MAX_FILE_BYTES } from './data.js';

self.onmessage = async ({ data }) => {
  try {
    if (data.size > MAX_FILE_BYTES) throw new Error('当前版本支持最大 256 MiB 的文件');
    const text = data.file ? await data.file.text() : data.text;
    self.postMessage({ result: parseDocument(text, data.name), text: data.keepText ? text : null });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
