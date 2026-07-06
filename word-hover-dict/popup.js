const HOVER_ENABLED_KEY = 'whd_hover_enabled';
const TRANSLATE_ENABLED_KEY = 'whd_translate_enabled';

const hoverToggle = document.getElementById('hoverToggle');
const translateToggle = document.getElementById('translateToggle');

chrome.storage.local.get([HOVER_ENABLED_KEY, TRANSLATE_ENABLED_KEY], (res) => {
  hoverToggle.checked = res[HOVER_ENABLED_KEY] === true;
  translateToggle.checked = res[TRANSLATE_ENABLED_KEY] === true;
});

hoverToggle.addEventListener('change', () => {
  chrome.storage.local.set({ [HOVER_ENABLED_KEY]: hoverToggle.checked });
});

translateToggle.addEventListener('change', () => {
  chrome.storage.local.set({ [TRANSLATE_ENABLED_KEY]: translateToggle.checked });
});
