(function () {
  'use strict';

  const HOVER_DELAY = 50;
  const HIDE_DELAY = 10;
  const HIT_TOLERANCE = 4;
  const CACHE_PREFIX = 'wordhover_cache_';
  const HOVER_ENABLED_KEY = 'whd_hover_enabled';
  const TRANSLATE_ENABLED_KEY = 'whd_translate_enabled';
  const HIGHLIGHT_NAME = 'whd-word';

  let hoverEnabled = false;
  let translateEnabled = false;

  let hoverTimer = null;
  let hideTimer = null;
  let lastWord = null;
  let card = null;
  let ticking = false;
  let lastEvent = null;
  const memCache = Object.create(null);

  const supportsHighlight = typeof Highlight !== 'undefined' && !!CSS.highlights;
  let wordHighlight = null;
  if (supportsHighlight) {
    wordHighlight = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, wordHighlight);
  }

  function setWordHighlight(range) {
    if (!supportsHighlight) return;
    wordHighlight.clear();
    wordHighlight.add(range);
  }

  function clearWordHighlight() {
    if (!supportsHighlight) return;
    wordHighlight.clear();
  }

  chrome.storage.local.get([HOVER_ENABLED_KEY, TRANSLATE_ENABLED_KEY], (res) => {
    hoverEnabled = res[HOVER_ENABLED_KEY] === true;
    translateEnabled = res[TRANSLATE_ENABLED_KEY] === true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes[HOVER_ENABLED_KEY]) {
      hoverEnabled = changes[HOVER_ENABLED_KEY].newValue === true;
      if (!hoverEnabled) {
        clearTimeout(hoverTimer);
        clearTimeout(hideTimer);
        clearWordHighlight();
        hideCard();
      }
    }

    if (changes[TRANSLATE_ENABLED_KEY]) {
      translateEnabled = changes[TRANSLATE_ENABLED_KEY].newValue === true;
      if (!translateEnabled) {
        resetSpaceState();
      }
    }
  });

  // ---------- 1. 定位鼠标下的单词 ----------
  function getWordAtPoint(x, y) {
    let range;
    try {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos || !pos.offsetNode) return null;
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.setEnd(pos.offsetNode, pos.offset);
      } else if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(x, y);
      }
    } catch (e) {
      return null;
    }

    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    const node = range.startContainer;
    const text = node.textContent;
    let start = range.startOffset;
    let end = range.startOffset;

    if (start < text.length && /\s/.test(text[start]) && (start === 0 || /\s/.test(text[start - 1]))) {
      return null;
    }

    while (start > 0 && /[a-zA-Z'-]/.test(text[start - 1])) start--;
    while (end < text.length && /[a-zA-Z'-]/.test(text[end])) end++;

    const word = text.slice(start, end).replace(/^[-']+|[-']+$/g, '');
    if (!word || !/^[a-zA-Z]{2,}$/.test(word)) return null;

    if (card && card.contains(node)) return null;

    const wordRange = document.createRange();
    wordRange.setStart(node, start);
    wordRange.setEnd(node, end);
    const rect = wordRange.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    if (
      x < rect.left - HIT_TOLERANCE ||
      x > rect.right + HIT_TOLERANCE ||
      y < rect.top - HIT_TOLERANCE ||
      y > rect.bottom + HIT_TOLERANCE
    ) {
      return null;
    }

    return { word: word.toLowerCase(), rect, range: wordRange };
  }

  // ---------- 2. 缓存读写 ----------
  function getCached(word) {
    if (word in memCache) return Promise.resolve(memCache[word]);
    return new Promise((resolve) => {
      const key = CACHE_PREFIX + word;
      chrome.storage.local.get([key], (result) => {
        const data = result[key] || null;
        if (data) memCache[word] = data;
        resolve(data);
      });
    });
  }

  function setCached(word, data) {
    memCache[word] = data;
    chrome.storage.local.set({ [CACHE_PREFIX + word]: data });
  }

  // ---------- 3. 查词：交给 background 处理，避免网页环境被有道服务器拦截 ----------
  function fetchYoudao(word) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'WHD_LOOKUP', word }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ error: true });
          return;
        }
        resolve(response);
      });
    });
  }

  async function fetchDefinition(word) {
    const cached = await getCached(word);
    if (cached) return cached;

    let data;
    try {
      data = await fetchYoudao(word);
    } catch (e) {
      data = { error: true };
    }

    if (!data.error) setCached(word, data);
    return data;
  }

  // ---------- 4. 渲染卡片 ----------
  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.id = 'word-hover-dict-card';
    document.body.appendChild(card);
    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderResult(data, rect, word) {
    const el = ensureCard();

    if (data.notFound) {
      el.innerHTML = `
        <div class="whd-header"><span class="whd-word">${escapeHtml(word)}</span></div>
        <div class="whd-notfound">未找到释义</div>`;
      positionCard(rect);
      return;
    }
    if (data.error) {
      el.innerHTML = `<div class="whd-error">查询失败，请检查网络</div>`;
      positionCard(rect);
      return;
    }

    let html = `<div class="whd-header"><span class="whd-word">${escapeHtml(data.word)}</span></div>`;

    if (data.ukphone || data.usphone) {
      html += `<div class="whd-ipa-row">
        ${data.ukphone ? `<span class="whd-ipa"><i>英</i>/${escapeHtml(data.ukphone)}/</span>` : ''}
        ${data.usphone ? `<span class="whd-ipa"><i>美</i>/${escapeHtml(data.usphone)}/</span>` : ''}
      </div>`;
    }

    if (data.trs && data.trs.length > 0) {
      html += `<div class="whd-trs">
        ${data.trs
          .map(
            (t) =>
              `<div class="whd-trs-row">${t.pos ? `<span class="whd-trs-pos">${escapeHtml(t.pos)}</span>` : ''}<span class="whd-trs-tran">${escapeHtml(t.tran)}</span></div>`
          )
          .join('')}
      </div>`;
    }

    if (data.example && data.example.en) {
      html += `<div class="whd-example-block">
        <div class="whd-example-en">${escapeHtml(data.example.en)}</div>
        ${data.example.zh ? `<div class="whd-example-zh">${escapeHtml(data.example.zh)}</div>` : ''}
      </div>`;
    }

    el.innerHTML = html;
    positionCard(rect);
  }

  function positionCard(rect) {
    const el = ensureCard();
    el.style.display = 'block';

    const margin = 8;
    const cardWidth = el.offsetWidth || 260;
    const cardHeight = el.offsetHeight || 100;

    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + margin;

    if (left + cardWidth > window.scrollX + window.innerWidth - margin) {
      left = window.scrollX + window.innerWidth - cardWidth - margin;
    }
    if (rect.bottom + cardHeight + margin > window.innerHeight) {
      top = rect.top + window.scrollY - cardHeight - margin;
    }

    el.style.left = `${Math.max(margin, left)}px`;
    el.style.top = `${Math.max(margin, top)}px`;
  }

  function hideCard() {
    if (card) card.style.display = 'none';
    lastWord = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      clearWordHighlight();
      hideCard();
    }, HIDE_DELAY);
  }

  // ---------- 5. 悬停查词事件绑定 ----------
  function handleMove(e) {
    const hit = getWordAtPoint(e.clientX, e.clientY);

    if (!hit) {
      clearTimeout(hoverTimer);
      scheduleHide();
      return;
    }

    clearTimeout(hideTimer);

    if (hit.word === lastWord) return;

    setWordHighlight(hit.range);

    clearTimeout(hoverTimer);
    lastWord = hit.word;

    hoverTimer = setTimeout(async () => {
      if (lastWord !== hit.word) return;
      const data = await fetchDefinition(hit.word);
      if (lastWord !== hit.word) return;
      renderResult(data, hit.rect, hit.word);
    }, HOVER_DELAY);
  }

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!hoverEnabled) return;
      lastEvent = e;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          handleMove(lastEvent);
          ticking = false;
        });
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'scroll',
    () => {
      if (!hoverEnabled) return;
      clearWordHighlight();
      hideCard();
    },
    { passive: true, capture: true }
  );

  // ==================================================================
  // 6. 输入框翻译：双击空格 -> 翻译成英文；⌘+J -> 翻译成日文
  //    这个功能受 translateEnabled 独立开关控制，与悬停查词互不影响
  // ==================================================================

  // 双击判定窗口：故意调得比正常打字习惯里的两个空格更紧凑，
  // 200ms 大概是"有意识快速点两下"和"自然打字节奏"之间比较可靠的分界线
  const SPACE_RAPID_WINDOW = 200;

  // 翻译中提示的滚动点动画
  const DOT_FRAMES = ['...', '...', '...'];
  const DOT_INTERVAL = 400;

  const spaceState = {
    el: null,
    lastTime: 0
  };

  function resetSpaceState() {
    spaceState.el = null;
    spaceState.lastTime = 0;
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'tel', 'email', ''].includes(type);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function getElementText(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
    return el.innerText;
  }

  // 纯写入内容，不处理光标（动画滚动期间频繁调用，输入框处于只读状态，不需要每次都摆弄光标）
  function setText(el, text) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = text;
    } else {
      el.innerText = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function placeCaretAtEnd(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch (e) {
        // 部分 input type（如 email/number）不支持 setSelectionRange，忽略即可
      }
    } else {
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // 翻译期间临时锁定输入框，防止动画滚动和用户继续打字互相打架
  function setLocked(el, locked) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.readOnly = locked;
    } else {
      el.contentEditable = locked ? 'false' : 'true';
    }
  }

  function requestGoogleTranslate(text, to) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'WHD_TRANSLATE', text, to }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ error: true });
          return;
        }
        resolve(response);
      });
    });
  }

  // 记录每个输入框"上一次翻译后的完整内容 + 目标语言"，用于判断这次触发时
  // 输入框里哪部分是新增的、哪部分已经翻译过了（增量翻译）
  const lastTranslatedMap = new WeakMap();

  // 触发翻译时：
  // - 如果当前内容 = 上次翻译结果 + 新增内容（且目标语言没变），只把新增部分发去翻译，
  //   翻完后拼接在已翻译内容后面，避免把中英文混在一起整体重译造成语序错乱、语言误判
  // - 否则（用户改了中间内容、清空重写、或切换了目标语言）视为全新的一次翻译，整体重译
  async function triggerTranslate(el, targetLang) {
    if (!el || el.dataset.whdTranslating === '1') return;

    const raw = getElementText(el);
    const current = raw.replace(/\s+$/, ''); // 去掉触发用的尾部空格
    if (!current) return;

    const prevRecord = lastTranslatedMap.get(el);

    let toTranslate = current;
    let prefix = '';
    let isIncremental = false;

    if (prevRecord && prevRecord.lang === targetLang && current.startsWith(prevRecord.text)) {
      const delta = current.slice(prevRecord.text.length).trim();
      if (!delta) return; // 跟上次翻译结果完全一样，没有新增内容，不用再翻一次
      toTranslate = delta;
      prefix = prevRecord.text + (/\s$/.test(prevRecord.text) ? '' : ' ');
      isIncremental = true;
    }

    el.dataset.whdTranslating = '1';
    setLocked(el, true);

    let dotIndex = 0;
    setText(el, current + DOT_FRAMES[dotIndex]);
    const animTimer = setInterval(() => {
      dotIndex = (dotIndex + 1) % DOT_FRAMES.length;
      setText(el, current + DOT_FRAMES[dotIndex]);
    }, DOT_INTERVAL);

    const result = await requestGoogleTranslate(toTranslate, targetLang);

    clearInterval(animTimer);
    setLocked(el, false);
    delete el.dataset.whdTranslating;

    if (result.error || typeof result.text !== 'string' || !result.text) {
      // 翻译失败，安静地恢复触发前的完整内容（增量或全量都一样，恢复到 current 即可）
      setText(el, current);
      placeCaretAtEnd(el);
      return;
    }

    const finalText = isIncremental ? prefix + result.text : result.text;
    setText(el, finalText);
    lastTranslatedMap.set(el, { text: finalText, lang: targetLang });
    placeCaretAtEnd(el);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!translateEnabled) return;

      const el = e.target;
      if (!isEditableElement(el)) return;
      if (el.dataset.whdTranslating === '1') return; // 翻译动画滚动中，忽略新的触发

      // ⌘+J（Mac）触发翻译成日文
      if (e.metaKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        resetSpaceState();
        triggerTranslate(el, 'ja');
        return;
      }

      const isSpace = e.code === 'Space' || e.key === ' ';
      if (!isSpace) {
        resetSpaceState();
        return;
      }

      const now = Date.now();

      // 不是同一个输入框，或距离上次空格太久 -> 视为普通打字的第一个空格，正常插入
      if (el !== spaceState.el || now - spaceState.lastTime > SPACE_RAPID_WINDOW) {
        spaceState.el = el;
        spaceState.lastTime = now;
        return;
      }

      // 200ms 内的第二次空格：判定为双击，拦截这一下并立即触发翻译
      e.preventDefault();
      resetSpaceState();
      triggerTranslate(el, 'en');
    },
    true // capture 阶段拦截，确保能在页面自身逻辑之前 preventDefault
  );
})();