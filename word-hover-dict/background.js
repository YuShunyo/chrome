const HOVER_ENABLED_KEY = 'whd_hover_enabled';
const TRANSLATE_ENABLED_KEY = 'whd_translate_enabled';

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

// 图标状态：两个功能只要有一个开着，就显示"开启"图标
function updateIcon(hoverEnabled, translateEnabled) {
  const anyOn = hoverEnabled || translateEnabled;
  chrome.action.setIcon({ path: anyOn ? ICONS.on : ICONS.off });
  chrome.action.setTitle({
    title: '悬停查词 / 输入框翻译（点击图标打开设置面板）'
  });
}

function init() {
  chrome.storage.local.get([HOVER_ENABLED_KEY, TRANSLATE_ENABLED_KEY], (res) => {
    const hoverEnabled = res[HOVER_ENABLED_KEY] === true;
    const translateEnabled = res[TRANSLATE_ENABLED_KEY] === true;

    // 默认都关闭
    const updates = {};
    if (res[HOVER_ENABLED_KEY] === undefined) updates[HOVER_ENABLED_KEY] = false;
    if (res[TRANSLATE_ENABLED_KEY] === undefined) updates[TRANSLATE_ENABLED_KEY] = false;
    if (Object.keys(updates).length > 0) chrome.storage.local.set(updates);

    updateIcon(hoverEnabled, translateEnabled);
  });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// popup.js 里切换开关会写入 storage，这里统一监听并刷新图标
// （manifest 里设置了 default_popup，所以不再需要 action.onClicked 逻辑）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!(HOVER_ENABLED_KEY in changes) && !(TRANSLATE_ENABLED_KEY in changes)) return;

  chrome.storage.local.get([HOVER_ENABLED_KEY, TRANSLATE_ENABLED_KEY], (res) => {
    updateIcon(res[HOVER_ENABLED_KEY] === true, res[TRANSLATE_ENABLED_KEY] === true);
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

// ---------- 输入框整句翻译：用谷歌免费接口（client=gtx，无需 tk 校验，无需 Key） ----------
// sl=auto 自动识别源语言，理论上任何谷歌翻译支持的语言都能作为输入
async function googleTranslate(text, targetLang) {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`translate request failed: ${res.status}`);
  

  const json = await res.json();
  // 返回结构形如 [[["译文块1","原文块1",...], ["译文块2","原文块2",...], ...], ...]
  const chunks = json?.[0] || [];
  const translated = chunks.map((chunk) => chunk?.[0] || '').join('');
  return translated;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'WHD_LOOKUP') {
    fetchYoudao(message.word)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: true, message: String(err) }));
    return true; // 告知 Chrome 会异步调用 sendResponse
  }

  if (message?.type === 'WHD_TRANSLATE') {
    googleTranslate(message.text, message.to)
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: true, message: String(err) }));
    return true;
  }

  return false;
});
