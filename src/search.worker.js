import { searchData } from './data.js';
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ result: await searchData(data.value, data.query, { ...data.options,
      yieldTask: () => { self.postMessage({ progress: true }); return new Promise(resolve => setTimeout(resolve, 0)); }
    }) });
  }
  catch (error) { self.postMessage({ error: error.message }); }
};
