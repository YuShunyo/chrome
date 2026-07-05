(function () {
  'use strict';

  const HOVER_DELAY = 50;
  const HIDE_DELAY = 10;
  const HIT_TOLERANCE = 4;
  const CACHE_PREFIX = 'wordhover_cache_';
  const ENABLED_KEY = 'whd_enabled';
  const HIGHLIGHT_NAME = 'whd-word';

  let enabled = false;
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

  chrome.storage.local.get([ENABLED_KEY], (res) => {
    enabled = res[ENABLED_KEY] === true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ENABLED_KEY]) {
      enabled = changes[ENABLED_KEY].newValue === true;
      if (!enabled) {
        clearTimeout(hoverTimer);
        clearTimeout(hideTimer);
        clearWordHighlight();
        hideCard();
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

  // ---------- 5. 事件绑定 ----------
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
      if (!enabled) return;
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
      if (!enabled) return;
      clearWordHighlight();
      hideCard();
    },
    { passive: true, capture: true }
  );
})();
