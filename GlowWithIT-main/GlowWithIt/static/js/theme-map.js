// theme-map.js
export function initMapThemeSync(map, {
  nightMapId = '113d7a8f2e2e9058eed0d64b',
  lightMapId = null, // null -> Google default light style
  storageKey = 'gw:theme' // 'auto' | 'light' | 'dark'
} = {}) {
  const prefersDark = () =>
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  function getStored() {
    return localStorage.getItem(storageKey) || 'auto';
  }
  function setStored(v) {
    localStorage.setItem(storageKey, v);
  }

  function resolveTheme(mode = getStored()) {
    if (mode === 'auto') return prefersDark() ? 'dark' : 'light';
    return mode;
  }

  function applyMapTheme(mode = resolveTheme()) {
    const isDark = mode === 'dark';
    map.setOptions({
      mapId: isDark ? nightMapId : lightMapId || undefined,
      // optional: tweak label/POI density at night
      // backgroundColor: isDark ? '#0b0f1a' : undefined
    });
  }

  // Initial apply
  applyMapTheme();

  // Watch OS theme if in auto
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', () => {
    if (getStored() === 'auto') applyMapTheme('auto');
  });

  // Watch <html data-theme="..."> if your site toggles that
  const html = document.documentElement;
  const mo = new MutationObserver(() => {
    // If your site sets data-theme, sync map unless user forced manual mode
    if (getStored() !== 'auto') return;
    const t = (html.getAttribute('data-theme') || '').toLowerCase();
    if (t === 'dark' || t === 'light') applyMapTheme(t);
  });
  mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });

  // Public API to let your UI set the mode explicitly
  return {
    applyMapTheme,                 // applyMapTheme('light'|'dark'|'auto')
    setMode(mode) {                // persist + apply
      setStored(mode); 
      applyMapTheme(mode);
    },
    getMode() { return getStored(); },
    resolveTheme
  };
}
