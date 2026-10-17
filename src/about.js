import manifest from '../package.json';
import licenseText from '../LICENSE?raw';

const dialog = document.getElementById('aboutDialog');
const status = document.getElementById('aboutStatus');
const projectUrl = 'https://github.com/The-cute-cat/json-atlas';

document.getElementById('aboutVersion').textContent = `版本 ${manifest.version}`;
document.getElementById('aboutLicenseText').textContent = licenseText;

export function openAbout() {
  if (dialog.open) return;
  status.textContent = '';
  document.getElementById('aboutLicense').open = false;
  dialog.showModal();
  // Opening a short window must not scroll to a previously focused footer button.
  dialog.scrollTop = 0;
  document.getElementById('aboutBody').scrollTop = 0;
  document.getElementById('aboutLicenseText').scrollTop = 0;
}

document.getElementById('aboutClose').addEventListener('click', () => dialog.close());
document.getElementById('aboutConfirm').addEventListener('click', () => dialog.close());
document.getElementById('aboutBtn').addEventListener('click', openAbout);
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
document.getElementById('aboutCopyProject').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(projectUrl);
    status.textContent = '项目地址已复制';
  } catch {
    status.textContent = '未能复制，请选择上方项目地址手动复制';
  }
});
