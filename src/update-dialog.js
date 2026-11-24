import { msg, t } from './i18n.js';
import manifest from '../package.json';
import { desktop, openReleasePage } from './desktop.js';
import { checkLatestRelease } from './releases.js';

const lastCheckKey = 'json-atlas-last-update-check';
const autoCheckKey = 'json-atlas-auto-check-updates';
const dismissedKey = 'json-atlas-dismissed-release';
const day = 24 * 60 * 60 * 1000;
let requestInProgress;

function updatePreference(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* Checking updates still works if settings cannot be stored. */ }
}

function fetchUpdate() {
  if (!requestInProgress) {
    requestInProgress = checkLatestRelease(manifest.version).finally(() => { requestInProgress = null; });
  }
  return requestInProgress;
}

export function openUpdateCheck() {
  if (!desktop) return;
  const dialog = document.getElementById('updateDialog');
  if (dialog.open) return;
  dialog.showModal();
  document.getElementById('updateCheckAgain').click();
}

if (desktop) {
  const automatic = document.getElementById('autoCheckUpdates');
  const check = document.getElementById('updateCheckAgain');
  const result = document.getElementById('updateStatus');
  const releaseButton = document.getElementById('updateOpenRelease');
  const notice = document.getElementById('updateNotice');
  const message = document.getElementById('updateNoticeMessage');
  let noticeVersion;
  let lastCheck = Number(updatePreference(lastCheckKey)) || 0;
  let dismissed = updatePreference(dismissedKey);

  const dismissNotice = () => {
    notice.hidden = true;
    dismissed = noticeVersion;
    updatePreference(dismissedKey, dismissed);
  };
  const recordCheck = () => {
    lastCheck = Date.now();
    updatePreference(lastCheckKey, String(lastCheck));
  };
  async function checkAutomatically() {
    const elapsed = Date.now() - lastCheck;
    if (!automatic.checked || (elapsed >= 0 && elapsed < day)) return;
    recordCheck();
    try {
      const version = await fetchUpdate();
      if (!automatic.checked || !version || version === dismissed) return;
      noticeVersion = version;
      notice.hidden = false;
      message.textContent = msg`发现新版本 v${version}`;
    } catch { /* Background checks stay silent when GitHub is unavailable. */ }
  }

  document.getElementById('updateVersion').textContent = msg`当前版本 ${manifest.version}`;
  automatic.checked = updatePreference(autoCheckKey) !== 'false';
  automatic.addEventListener('change', () => {
    updatePreference(autoCheckKey, String(automatic.checked));
    if (automatic.checked) void checkAutomatically();
    else notice.hidden = true;
  });
  check.addEventListener('click', async () => {
    check.disabled = true;
    releaseButton.hidden = true;
    result.textContent = t('正在检查 GitHub Releases…');
    try {
      const version = await fetchUpdate();
      recordCheck();
      result.textContent = version ? msg`发现新版本 v${version}` : t('没有可用的新版本');
      releaseButton.hidden = !version;
    } catch {
      result.textContent = t('无法检查更新，请稍后重试');
    } finally {
      check.disabled = false;
    }
  });
  releaseButton.addEventListener('click', () => {
    openReleasePage().catch(() => { result.textContent = t('无法打开浏览器，请访问项目的 GitHub Releases 页面'); });
  });
  document.getElementById('updateNoticeOpen').addEventListener('click', () => {
    openReleasePage().then(dismissNotice).catch(() => { message.textContent = t('无法打开浏览器'); });
  });
  document.getElementById('updateNoticeDismiss').addEventListener('click', dismissNotice);
  setTimeout(checkAutomatically, 2500);
  setInterval(checkAutomatically, 60 * 60 * 1000);
}
