import StoryContent from "./story-content.js";
import SafetyStory from "./safety-stories.js";
import Card from "./self-check-card.js";
import { loadStoryLineFrames } from "./storyframes-loader.js";
import {
  calculateScoreForAssessmentForm,
  top3Categories,
  buildPersonalisedSafetyPlan,
  scoringTips,
} from "./scoring.js";

(function enforcePasscodeGate() {
  try {
    const FLAG = "password_passed";
    const unlocked =
      sessionStorage.getItem(FLAG) === "1" ||
      localStorage.getItem(FLAG) === "1";
    const EXEMPT = [
      /^\/$/, /^\/static\//, /^\/admin\//, /^\/api\//, /^\/favicon\.ico$/,
    ].some(rx => rx.test(location.pathname));
    if (!unlocked && !EXEMPT) {
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      location.replace("/?next=" + next);
    }
  } catch (_) {}
})();

document.addEventListener("DOMContentLoaded", () => {
  Object.assign(window, {
    calculateScoreForAssessmentForm, top3Categories, buildPersonalisedSafetyPlan, scoringTips,
  });

  (async () => {
    let storySetting = {};
    try { storySetting = await loadStoryLineFrames("/static/json/storyFrames.json"); }
    catch (e) { console.warn("storyFrames.json could not be loaded;", e); }

    // instances
    let safetyStoryContent = new StoryContent();
    const story = new SafetyStory();
    let card = new Card(safetyStoryContent, story, storySetting);

    function mountAssessment() {
      card?.destroy?.();
      safetyStoryContent = new StoryContent();
      card = new Card(safetyStoryContent, story, storySetting);
    }

    // DOM
    const startCardBtn = document.getElementById("startCardBtn");
    const closeCardBtn = document.getElementById("closeCardBtn");   // inside #safetyCard
    const safetyCard   = document.getElementById("safetyCard");
    const resultsCard  = document.getElementById("resultsCard");
    const preCardBlock = document.getElementById("preCardBlock");

    // a single close handler used everywhere
    const closeAll = () => {
      safetyCard?.classList.add("d-none");
      resultsCard?.classList.add("d-none");
      preCardBlock?.classList.remove("d-none");
      card?.destroy?.();
    };

    // ensure a Close button exists in resultsCard, wire it to closeAll
    function ensureResultsClose() {
      if (!resultsCard) return;
      let btn = resultsCard.querySelector("#closeResultsBtn");
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "closeResultsBtn";
        btn.className = "btn btn-outline-light rounded-circle float-end";
        btn.title = "Close";
        btn.innerHTML = '<i class="bi bi-x-lg"></i>';
        // insert in a lightweight header row
        const header = document.createElement("div");
        header.className = "d-flex justify-content-end mb-2";
        header.appendChild(btn);
        const body = resultsCard.querySelector(".card-body") || resultsCard;
        body.prepend(header);
      }
      btn.onclick = closeAll;
    }

    // Call once now…
    ensureResultsClose();
    // …and again whenever results card content mutates (e.g., plan renders)
    const mo = new MutationObserver(ensureResultsClose);
    if (resultsCard) mo.observe(resultsCard, { childList: true, subtree: true });

    // Start assessment
    startCardBtn?.addEventListener("click", () => {
      preCardBlock?.classList.add("d-none");
      resultsCard?.classList.add("d-none");
      safetyCard?.classList.remove("d-none");
      mountAssessment();
      card.moveToTargetedStep?.(1);
    });

    // Existing close on the assessment card
    closeCardBtn?.addEventListener("click", closeAll);
  })();

  // ------- Passcode gate -------
  const password = "glow2025";
  const sessionKey = "password_passed";
  const gate = document.getElementById("pw-gate-input");
  const content = document.querySelector("#glowwithit-content, .glowwithit-content");
  const input = document.getElementById("pw-input");
  const submit = document.getElementById("pw-submit");
  const error = document.getElementById("pw-error");
  const lockScroll = (on) => {
    document.documentElement.style.overflow = on ? "hidden" : "";
    document.body.style.overflow = on ? "hidden" : "";
  };
  const alreadyOk =
    sessionStorage.getItem(sessionKey) === "1" ||
    localStorage.getItem(sessionKey) === "1";

  function unlockScreen() {
    if (gate) gate.style.display = "none";
    lockScroll(false);
    if (content) content.style.filter = "none";
    try { sessionStorage.setItem(sessionKey, "1"); localStorage.setItem(sessionKey, "1"); } catch {}
    try {
      const url = new URL(location.href);
      const next = url.searchParams.get("next");
      if (next) {
        url.searchParams.delete("next");
        history.replaceState(null, "", url.pathname + url.search);
        location.assign(next);
        return;
      }
    } catch (_) {}
  }
  function showPassword() {
    if (!gate) return;
    gate.style.display = "grid";
    lockScroll(true);
    setTimeout(() => input && input.focus(), 60);
  }
  function loginPage() {
    if (input.value === password) {
      unlockScreen();
    } else {
      error.textContent = "Incorrect password. Please type again.";
      gate.classList.add("pw-shake");
      setTimeout(() => gate.classList.remove("pw-shake"), 300);
      input.value = "";
      input.focus();
    }
  }
  if (alreadyOk) {
    unlockScreen();
  } else {
    showPassword();
    submit?.addEventListener("click", loginPage);
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") loginPage(); });
  }

  // ------- Theme image swapping / banner -------
  (function () {
    function isBright() {
      const d = document.documentElement, b = document.body;
      return d.classList.contains('gw-bright') ||
             b.classList.contains('gw-bright') ||
             d.dataset.theme === 'bright' || b.dataset.theme === 'bright';
    }
    function preload(url) { if (url) { const img = new Image(); img.src = url; } }
    function applyThemeImages() {
      const bright = isBright();
      document.querySelectorAll('img.theme-swap').forEach(img => {
        const next = (isBright() ? img.dataset.brightSrc : img.dataset.darkSrc);
        if (!next) { console.warn('[theme-swap] Missing data-* src on image:', img); return; }
        const current = img.currentSrc || img.src;
        if (current === next) return;
        const prev = current, test = new Image();
        test.onload = () => { img.src = next; };
        test.onerror = () => { console.warn('[theme-swap] Failed to load', next, '— keeping', prev); img.src = prev; };
        test.src = next;
      });
      const banner = document.querySelector('.banner');
      if (banner) {
        const darkBg = banner.getAttribute('data-dark-bg');
        const brightBg = banner.getAttribute('data-bright-bg');
        const url = bright ? brightBg : darkBg;
        if (url) {
          preload(url);
          banner.style.background = `url('${url}') no-repeat center center`;
          banner.style.backgroundSize = 'cover';
          banner.style.minHeight = '80vh';
        }
      }
    }
    applyThemeImages();
    const mo = new MutationObserver(applyThemeImages);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class','data-theme'] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class','data-theme'] });
    document.addEventListener('gw-theme-change', applyThemeImages);
    window.addEventListener('storage', (e) => { if (e.key === 'gw-theme') applyThemeImages(); });
  })();

  // ------- Theme toggle -------
  (() => {
    const STORAGE_KEY = 'gw-theme';
    const html = document.documentElement;
    const body = document.body;
    const sw = document.getElementById('gwSwitch');
    const label = document.getElementById('gwToggleLabel');
    function apply(mode) {
      const bright = mode === 'bright';
      html.classList.toggle('gw-bright', bright);
      body.classList.toggle('gw-bright', bright);
      html.dataset.theme = bright ? 'bright' : 'night';
      body.dataset.theme = bright ? 'bright' : 'night';
      if (sw) sw.checked = bright;
      if (label) label.textContent = bright ? 'Bright Mode' : 'Night Mode';
      try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
      document.dispatchEvent(new Event('gw-theme-change'));
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial = saved || (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'bright' : 'night');
    apply(initial);
    sw?.addEventListener('change', () => apply(sw.checked ? 'bright' : 'night'));
  })();

  function placeThemeToggle() {
    const nav = document.getElementById('siteNav');
    const ribbon = document.querySelector('.emergency-banner');
    const gap = 10;
    const headerHeight = (nav?.offsetHeight || 0) + (ribbon?.offsetHeight || 0) + gap;
    if (!window.matchMedia('(min-width: 1600px)').matches) {
      document.documentElement.style.setProperty('--gw-toggle-top', `${headerHeight}px`);
    }
  }
  window.addEventListener('load', placeThemeToggle);
  window.addEventListener('resize', placeThemeToggle);

  (function setToggleOffset(){
    function update(){
      const nav = document.getElementById('siteNav');
      const ribbon = document.querySelector('.emergency-banner');
      const navH = nav ? nav.offsetHeight : 56;
      const ribH = ribbon ? ribbon.offsetHeight : 0;
      const px = navH + ribH + 8;
      document.documentElement.style.setProperty('--gw-toggle-offset', px + 'px');
    }
    update();
    window.addEventListener('resize', update, { passive: true });
  })();
});
