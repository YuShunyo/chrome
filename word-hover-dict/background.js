const ENABLED_KEY = 'whd_enabled';

const ICONS = {
  on: {
    16: 'icons/on/icon16.png',
    32: 'icons/on/icon32.png',
    48: 'icons/on/icon48.png',
    128: 'icons/on/icon128.png'
  },
  off: {
    16: 'icons/off/icon16.png',
    32: 'icons/off/icon32.png',
    48: 'icons/off/icon48.png',
    128: 'icons/off/icon128.png'
  }
};

function updateIcon(enabled) {
  chrome.action.setIcon({ path: enabled ? ICONS.on : ICONS.off });
  chrome.action.setTitle({
    title: enabled ? '悬停查词（当前：开启，点击关闭）' : '悬停查词（当前：关闭，点击开启）'
  });
}

function init() {
  chrome.storage.local.get([ENABLED_KEY], (res) => {
    // 默认关闭
    const enabled = res[ENABLED_KEY] === true;
    if (res[ENABLED_KEY] === undefined) {
      chrome.storage.local.set({ [ENABLED_KEY]: false });
    }
    updateIcon(enabled);
  });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.action.onClicked.addListener(() => {
  chrome.storage.local.get([ENABLED_KEY], (res) => {
    const current = res[ENABLED_KEY] === true;
    const next = !current;
    chrome.storage.local.set({ [ENABLED_KEY]: next }, () => {
      updateIcon(next);
    });
  });
});

// ---------- 查词请求：统一在 background 里发起，避免网页 Referer/Origin 被有道服务器拦截 ----------
async function fetchYoudao(word) {
  const url =
    `https://dict.youdao.com/jsonapi?jsonversion=2&client=mobile` +
    `&q=${encodeURIComponent(word)}&keyfrom=mdict.9.3.0.android`;

  const res = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!res.ok) return { error: true, status: res.status };
  const json = await res.json();

  const simpleWord = json.simple?.word?.[0] || {};
  const ukphone = simpleWord.ukphone || '';
  const usphone = simpleWord.usphone || '';

  // 中文释义在 ec.word[0].trs[].tr[].l.i[] 里，取出的字符串形如 "v. 寻找；谋求（seek 的 ing 形式）"，
  // 词性缩写和释义文本拼在一起，这里用正则把开头的词性摘出来单独做标签
  const ecWordArr = json.ec?.word;
  const ecWord = Array.isArray(ecWordArr) ? ecWordArr[0] : ecWordArr;
  const trsRaw = ecWord?.trs || [];
  const trs = trsRaw
    .map((t) => {
      const items = (t.tr || []).flatMap((trItem) => trItem?.l?.i || []);
      let combined = items.join('；');
      let pos = '';
      const m = combined.match(/^([a-zA-Z]{1,8}\.)\s*/);
      if (m) {
        pos = m[1];
        combined = combined.slice(m[0].length);
      }
      return { pos, tran: combined };
    })
    .filter((t) => t.tran)
    .slice(0, 5);

  const pair = json.blng_sents_part?.['sentence-pair']?.[0];
  const example = pair
    ? { en: pair.sentence || pair['sentence-eng'] || '', zh: pair['sentence-translation'] || '' }
    : null;

  if (!ukphone && !usphone && trs.length === 0) {
    return { notFound: true };
  }

  return { word, ukphone, usphone, trs, example };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'WHD_LOOKUP') return false;
  fetchYoudao(message.word)
    .then((data) => sendResponse(data))
    .catch((err) => sendResponse({ error: true, message: String(err) }));
  return true; // 告知 Chrome 会异步调用 sendResponse
});
