/* video-call.js (self-mounting modal + back-to-setup; record nudge + glow) */
(() => {

  // --- scheduling state + modal (self-mounted) ---
let scheduleTimeout = null;

function ensureScheduleModal(){
  if (document.getElementById('vc-sched-modal')) return;

  const clockGif = window.VC_CLOCK_GIF || '/static/images/clock-tick.gif';

  const wrap = document.createElement('div');
  wrap.id = 'vc-sched-modal';
  wrap.className = 'vc-sched d-none';
  wrap.setAttribute('role','dialog');
  wrap.setAttribute('aria-modal','true');
  wrap.innerHTML = `
    <div class="vc-sched__backdrop" aria-hidden="true"></div>
    <div class="vc-sched__card" role="document">
      <img class="vc-sched__img" alt="" src="${clockGif}">
      <h3 class="vc-sched__title">Call scheduled</h3>
      <p class="vc-sched__msg">We’ll ring <span id="vc-sched-when"></span>.</p>
      <div class="vc-sched__actions">
        <button type="button" id="vc-sched-cancel" class="btn-ghost-pill">Cancel</button>
        <button type="button" id="vc-sched-ok" class="btn-primary-pill">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // minimal styles (kept here so you don’t touch CSS file)
  const css = `
    .vc-sched{position:fixed;inset:0;display:grid;place-items:center;z-index:7500}
    .vc-sched.d-none{display:none}
    .vc-sched__backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}
    .vc-sched__card{position:relative;background:#0f172a;color:#fff;border:1px solid rgba(255,255,255,.12);
      width:min(420px,92vw);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.45);padding:18px;text-align:center}
    .gw-bright .vc-sched__card{background:#fff;color:#0f172a;border-color:#e5e7eb}
    .vc-sched__img{width:72px;height:72px;display:block;margin:4px auto 10px}
   .vc-sched__title{font-size:1.5rem;line-height:1.25;font-weight:800;letter-spacing:.2px;margin:6px 0 4px}
.vc-sched__time{font-size:1.125rem;line-height:1.45;opacity:.95;margin:0 0 10px}
    .vc-sched__msg{opacity:.9;margin:0 0 10px}
    .vc-sched__actions{display:flex;gap:.5rem;justify-content:center;margin-top:6px}
  `;
  const t = document.createElement('style'); t.textContent = css; document.head.appendChild(t);

  // handlers
  wrap.querySelector('.vc-sched__backdrop')?.addEventListener('click', closeScheduleModal);
  wrap.querySelector('#vc-sched-ok')?.addEventListener('click', closeScheduleModal);
  wrap.querySelector('#vc-sched-cancel')?.addEventListener('click', () => {
    cancelScheduledCall();
    closeScheduleModal();
    showToast?.('Scheduled call canceled');
  });
}

function openScheduleModal(whenDate){
  ensureScheduleModal();
  const m = document.getElementById('vc-sched-modal');
  const whenEl = document.getElementById('vc-sched-when');
  if (whenEl){
    const hh = String(whenDate.getHours()).padStart(2,'0');
    const mm = String(whenDate.getMinutes()).padStart(2,'0');
    const ss = String(whenDate.getSeconds()).padStart(2,'0');
    whenEl.textContent = `at ${hh}:${mm}:${ss}`;
  }
  m?.classList.remove('d-none');
  document.body.classList.add('is-modal-open');
}
function closeScheduleModal(){
  document.getElementById('vc-sched-modal')?.classList.add('d-none');
  document.body.classList.remove('is-modal-open');
}
function cancelScheduledCall(){
  if (scheduleTimeout){ clearTimeout(scheduleTimeout); scheduleTimeout = null; }
}
  // ------- helpers -------
  const $ = (id) => document.getElementById(id);
  const byQS = (sel, root = document) => root.querySelector(sel);
  const byQSA = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const REMOVE_THEME_CLASSES = [
  'vc-theme-pink','vc-theme-teal','vc-theme-dark',
  'vc-theme-yellow','vc-theme-blue','vc-theme-sakura',
  'vc-theme-beige','vc-theme-sky','vc-theme-lime','vc-theme-purple',
  'vc-theme-orange'
];

  // Themes that are actually selectable/valid now (no 'dark')
  const VALID_THEMES = REMOVE_THEME_CLASSES.filter(t => t !== 'vc-theme-dark');
  const DELAYS = new Set(['0','30','60','180']);
  const MAX_MEDIA_BYTES = 30 * 1024 * 1024; // 30MB

  // ------- DOM refs -------
  const incoming   = $('vc-incoming');
  const incall     = $('vc-incall');
  const ended      = $('vc-ended');
  const endedTime  = $('vc-ended-time');
  const endedName  = $('vc-ended-name');

  const audio      = $('vc-audio');
  const endSfx     = $('vc-end-sfx');
  const timeEl     = $('vc-time');

  const nameIn     = $('vc-name');
  const delaySel   = $('vc-delay');
  const themeSel   = $('vc-theme');
  const toneSel    = $('vc-tone');
  const mediaInp   = $('vc-media');

  const acceptBtn  = $('vc-accept');
  const declineBtn = $('vc-decline');
  const endBtn     = $('ctl-end');
  const micBtn     = $('ctl-mic');
  const recordBtn  = $('ctl-record');
  const recordingIndicator = $('vc-recording-indicator');

  const callerLbl  = $('vc-caller');
  const titleName  = $('vc-title-name');
  const timerLbl   = $('vc-timer');

  // vc-avatar appears in both incoming and in-call
  const avatarImgs = byQSA('#vc-incoming #vc-avatar, #vc-incall #vc-avatar');

  const ringNowBtn  = $('vc-now');
  const scheduleBtn = $('vc-schedule');
  const avatarGrid  = $('vc-avatars');
  let recSub = byQS('#vc-rec-modal .vc-rec-sub');

  // ---- tap GIF -> expose to CSS as a variable ----
  (function initTapGif(){
    const gif = (window.VC_TAP_GIF || '/static/images/tap-screen.gif');
    document.documentElement.style.setProperty('--vc-tap-gif', `url("${gif}")`);
  })();

  // ------- dynamic modal mount (so we don't rely on HTML) -------
  function mountModalIfMissing(){
    if ($('vc-rec-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'vc-rec-modal';
    modal.className = 'vc-rec-modal d-none';
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','vc-rec-title');

    modal.innerHTML = `
      <div class="vc-rec-modal__backdrop" aria-hidden="true"></div>
      <div class="vc-rec-modal__dialog">
        <header class="vc-rec-modal__head">
          <h3 id="vc-rec-title">Recording saved</h3>
          <button id="vc-rec-close" class="vc-rec-close" aria-label="Close">✕</button>
        </header>
        <div class="vc-rec-modal__body">
          <div id="vc-recents-modal-list" class="vc-recents-list"></div>
          <p class="vc-recents-hint">Your recordings stay until you refresh.</p>
        </div>
        <footer class="vc-rec-modal__foot">
          <button id="vc-rec-back" class="btn-ghost-pill">Back to setup</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modal);

    if (!$('vc-snackbar')) {
      const sb = document.createElement('div');
      sb.id = 'vc-snackbar';
      sb.className = 'vc-toast';
      sb.setAttribute('aria-live','polite');
      document.body.appendChild(sb);
    }

    const baseCSS = `
      .vc-rec-modal{position:fixed;inset:0;display:grid;place-items:center;z-index:7000}
      .vc-rec-modal.d-none{display:none}
      .vc-rec-modal__backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}
      .vc-rec-modal__dialog{position:relative;background:#0f172a;color:#fff;border:1px solid rgba(255,255,255,.12);
        width:min(680px,92vw);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.45);padding:12px}
      .gw-bright .vc-rec-modal__dialog{background:#fff;color:#0f172a;border-color:#e5e7eb}
      .vc-rec-modal__head,.vc-rec-modal__foot{display:flex;align-items:center;justify-content:space-between;padding:8px 12px}
      .vc-rec-modal__body{padding:10px 12px;max-height:min(60vh,520px);overflow:auto}
      .vc-rec-close{border:0;background:transparent;color:inherit;font-size:1.1rem;cursor:pointer}
      .vc-rec-item{display:grid;grid-template-columns:1fr auto;gap:.4rem .8rem;align-items:center;
        padding:.6rem .6rem;border-radius:10px;background:rgba(255,255,255,.06);margin:.3rem 0}
      .gw-bright .vc-rec-item{background:#f9fafb}
      .vc-rec-item audio{width:100%}
      .vc-rec-meta{opacity:.85;font-size:.9rem}
      .vc-rec-actions{display:flex;gap:.6rem}
      #vc-snackbar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(17,24,39,.9);
        color:#fff;padding:.6rem .9rem;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .2s, transform .2s;z-index:8000}
      #vc-snackbar.is-show{opacity:1;transform:translateX(-50%) translateY(-4px)}
    `;
    const tag = document.createElement('style');
    tag.textContent = baseCSS;
    document.head.appendChild(tag);
  }
  mountModalIfMissing();

  // Modal refs (after mount)
  let recModal       = $('vc-rec-modal');
  let recModalClose  = $('vc-rec-close');
  let recModalBack   = $('vc-rec-back');
  let recModalList   = $('vc-recents-modal-list');
  let snackbar       = $('vc-snackbar');

  // ------- state -------
  let timerInt = null;
  let startTs = null;
  let selectedAvatar = null;

  // recording state
  let selfStream = null;
  let mediaRecorder = null;
  let recChunks = [];
  let isRecording = false;

  // stop auto-hide of ended screen
  let endedTO = null;

  // ringtone state
  let audioCtx = null;
  let waStopper = null;
  let previewTO = null;
  let isRinging = false;

  const RECENT_LIMIT = 10;
  const recentUrls = new Set();
  const pendingRecents = [];

  function ensureRecentsEls(){
    if (!recModal || !recModalList) {
      mountModalIfMissing();
      recModal       = $('vc-rec-modal');
      recModalClose  = $('vc-rec-close');
      recModalBack   = $('vc-rec-back');
      recModalList   = $('vc-recents-modal-list');
      snackbar       = $('vc-snackbar');
      // FIX: support both template (.vc-rec-sub) and dynamic (.vc-recents-hint) subtitle nodes
      recSub         = byQS('#vc-rec-modal .vc-rec-sub') || byQS('#vc-rec-modal .vc-recents-hint');
      wireModalHandlers();
    }
    return { wrap: recModal, list: recModalList };
  }

  // FIX: cap only REAL items (ignore empty-state rows)
  function capRecents(list){
    const realItems = Array.from(list.children)
      .filter(n => !n.classList.contains('vc-rec-empty'));
    while (realItems.length > RECENT_LIMIT) {
      const last = realItems.pop();
      const a = last?.querySelector('a[data-url]');
      if (a?.dataset.url) { try { URL.revokeObjectURL(a.dataset.url); } catch {} recentUrls.delete(a.dataset.url); }
      last?.remove();
    }
  }

  function recRow(item){
    const row = document.createElement('div');
    row.className = 'vc-rec-item';

    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.src = item.url;

    const meta = document.createElement('div');
    meta.className = 'vc-rec-meta';
    meta.textContent = `${item.filename} • ${item.whenHuman}`;

    const actions = document.createElement('div');
    actions.className = 'vc-rec-actions';

    const dl = document.createElement('a');
    dl.href = item.url;
    dl.dataset.url = item.url;
    dl.download = item.filename;
    dl.textContent = 'Download';
    dl.className = 'vc-rec-btn vc-rec-btn--success';
    dl.setAttribute('role','button');
    dl.addEventListener('click', () => showSnack('Downloading recording…'));

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.className = 'vc-rec-btn vc-rec-btn--danger';

    rm.addEventListener('click', () => {
      try { URL.revokeObjectURL(item.url); } catch {}
      recentUrls.delete(item.url);
      row.remove();

      // FIX: guard against duplicating the empty-state; hide subtitle when none left
      const hasReal = !!recModalList?.querySelector('.vc-rec-item:not(.vc-rec-empty)');
      if (!hasReal) {
        if (!recModalList.querySelector('.vc-rec-empty')) {
          const emp = document.createElement('div');
          emp.className = 'vc-rec-empty vc-rec-item';
          emp.innerHTML = `<div class="vc-rec-meta">No recordings from this call.</div>`;
          recModalList?.appendChild(emp);
        }
        hideRecSubtitle();
      }
    });

    actions.appendChild(dl);
    actions.appendChild(rm);

    row.appendChild(audioEl);
    row.appendChild(meta);
    row.appendChild(actions);

    return row;
  }

  (function setRecordIcon(){
    if (!recordBtn) return;
    const icon = window.VC_REC_ICON || '/static/images/record-mic.png';
    recordBtn.innerHTML = `<img class="ctl-icon mic" alt="" src="${icon}"><span>Record</span>`;
  })();

  function removeEmptyState(){
    const emp = recModalList?.querySelector('.vc-rec-empty');
    if (emp) emp.remove();
  }

  function hideRecSubtitle(){ recSub?.classList.add('d-none'); }
  function showRecSubtitle(){ recSub?.classList.remove('d-none'); }

  function addRecentToDOM(item){
    const { wrap, list } = ensureRecentsEls();
    if (!wrap || !list) return false;
    removeEmptyState();
    capRecents(list);
    list.prepend(recRow(item));
    recentUrls.add(item.url);
    showRecSubtitle();
    return true;
  }

  function addRecentRecording(item){
    if (!addRecentToDOM(item)) pendingRecents.push(item);
    if (!ended.classList.contains('d-none')) openRecModal();
  }

  function flushPendingRecents(){
    if (!pendingRecents.length) return;
    const items = pendingRecents.splice(0);
    for (const it of items) addRecentToDOM(it);
  }

  window.addEventListener('beforeunload', () => {
    for (const u of recentUrls) { try { URL.revokeObjectURL(u); } catch {} }
    recentUrls.clear();
  });

  // ===== style injections =====
  (function injectGuards(){
    const css = `
      .vc-pulse, .vc-pulse .ring, #vc-incoming #vc-avatar, #vc-incall #vc-avatar { pointer-events: none; }
      #vc-incoming:not(.d-none), #vc-incall:not(.d-none), #vc-ended:not(.d-none) { pointer-events: auto; }
      #vc-incoming.d-none, #vc-incall.d-none, #vc-ended.d-none { display: none !important; pointer-events: none; }
      .vc-phone-actions, .vc-controls-grid { position: relative; z-index: 3; pointer-events: auto; }
      #ctl-record.is-recording { background:#ff8a00 !important; color:#000 !important; box-shadow:0 0 0 8px rgba(255,138,0,.2); transform:scale(1.02); }
      #vc-recording-indicator { display:inline-block; }
      #vc-recording-indicator.hidden { display:none !important; }
      .is-modal-open{ overflow:hidden; }
    `;
    const tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ------- tiny clock -------
  const tickClock = () => {
    // FIX: guard if #vc-time is not in DOM yet
    if (!timeEl) return;
    const d = new Date();
    timeEl.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  setInterval(tickClock, 1000); tickClock();

  // ------- local storage -------
  const KEY = 'vc.cfg';
  const loadCfg = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const saveCfg = (cfg) => localStorage.setItem(KEY, JSON.stringify(cfg));

  // ------- ringtone -------
  async function startRingtone(url, { preview = false } = {}) {
    stopRingtone();
    try {
      if (url) audio.src = url;
      audio.currentTime = 0;
      audio.loop = !preview;
      audio.volume = 1;
      audio.setAttribute('playsinline','');
      await audio.play();
      isRinging = !preview;
      if (preview) previewTO = setTimeout(stopRingtone, 2000);
      return;
    } catch (e) {}
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = 820; gain.gain.value = 0;
      osc.connect(gain); gain.connect(audioCtx.destination); osc.start();
      let alive = true;
      const loop = () => {
        if (!alive) return;
        const t = audioCtx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0.0, t);
        gain.gain.linearRampToValueAtTime(0.28, t + 0.02);
        gain.gain.setValueAtTime(0.28, t + 0.9);
        gain.gain.linearRampToValueAtTime(0.0, t + 1.0);
        setTimeout(loop, 1600);
      };
      loop();
      waStopper = () => { try{osc.stop()}catch{}; try{gain.disconnect()}catch{}; alive = false; };
      isRinging = !preview;
      if (preview) previewTO = setTimeout(stopRingtone, 2000);
    } catch {}
  }
  function stopRingtone() {
    try { audio.pause(); } catch {}
    if (previewTO) { clearTimeout(previewTO); previewTO = null; }
    if (waStopper) { waStopper(); waStopper = null; }
    isRinging = false;
  }

  // =========================
  // Validation
  // =========================
  const errColor = '#ff6b81';
  const errShadow = `0 0 0 3px ${errColor}55`;
  const fieldWrap = (el) => el?.closest?.('.vc-field') || el?.parentElement || null;

  function clearError(elOrWrap){
    const wrap = fieldWrap(elOrWrap) || elOrWrap; if (!wrap) return;
    wrap.querySelectorAll('.vc-error').forEach(n=>n.remove());
    const input = wrap.querySelector?.('.vc-input') || elOrWrap;
    if (input?.style) {
      input.style.removeProperty('box-shadow');
      input.style.removeProperty('border-color');
      input.removeAttribute('aria-invalid');
    }
    if (wrap?.style) {
      wrap.style.removeProperty('outline');
      wrap.style.removeProperty('outline-offset');
    }
  }
  function setError(elOrWrap,msg){
    const wrap = fieldWrap(elOrWrap) || elOrWrap; if (!wrap) return;
    clearError(wrap);
    const m = document.createElement('div');
    m.className='vc-error'; m.textContent=msg;
    m.style.color=errColor; m.style.fontSize='.85rem'; m.style.marginTop='4px';
    wrap.appendChild(m);
    const input = wrap.querySelector?.('.vc-input') || elOrWrap;
    if (input && input.style) {
      input.setAttribute('aria-invalid','true');
      input.style.setProperty('box-shadow', errShadow, 'important');
      input.style.setProperty('border-color', errColor, 'important');
    } else {
      wrap.style.setProperty('outline', `2px solid ${errColor}`, 'important');
      wrap.style.setProperty('outline-offset', '3px', 'important');
    }
  }
  function ensureErrorSummary(){
    let sum = byQS('#vc-errsum');
    if(!sum){
      sum = document.createElement('div');
      sum.id='vc-errsum'; sum.role='alert'; sum.setAttribute('aria-live','polite');
      sum.style.color=errColor; sum.style.margin='6px 0 0';
      byQS('.vc-config__head')?.appendChild(sum);
    }
    return sum;
  }
  function scrollFocus(el){
    if(!el) return;
    el.scrollIntoView?.({block:'center', behavior:'smooth'});
    (el.querySelector?.('input,select,button,[tabindex]')||el).focus?.();
  }
  function validateForm(show=true){
    let ok=true; const problems=[]; const first=[];
    [nameIn,toneSel,mediaInp,avatarGrid,byQS('.swatches'),byQS('.seg')].forEach(el=>el&&clearError(el));

    const nm = nameIn?.value?.trim() || '';
    if (nm.length < 2){ ok=false; problems.push('Caller name'); first.push(fieldWrap(nameIn)); if(show) setError(nameIn,'Enter a caller name (min 2 characters).'); }
    if (!DELAYS.has(String(delaySel?.value))){ ok=false; problems.push('Delay'); first.push(byQS('.seg')); if(show) setError(byQS('.seg'),'Pick one delay option.'); }
    if (!REMOVE_THEME_CLASSES.includes(String(themeSel?.value))){ ok=false; problems.push('Theme'); first.push(byQS('.swatches')); if(show) setError(byQS('.swatches'),'Choose a theme color.'); }
    if (!toneSel?.value){ ok=false; problems.push('Ringtone'); first.push(fieldWrap(toneSel)); if(show) setError(toneSel,'Choose a ringtone.'); }

    const f = mediaInp?.files?.[0];
    if (f){
      const okType = /^image\/|^video\//.test(f.type);
      if(!okType){ ok=false; problems.push('Photo/Video type'); first.push(fieldWrap(mediaInp)); if(show) setError(mediaInp,'Only images or videos are allowed.'); }
      else if (f.size > MAX_MEDIA_BYTES){ ok=false; problems.push('Photo/Video size'); first.push(fieldWrap(mediaInp)); if(show) setError(mediaInp,'File too large (max 30MB).'); }
    }

    if (!selectedAvatar){ ok=false; problems.push('Avatar'); first.push(avatarGrid); if(show) setError(avatarGrid,'Pick an avatar or upload an image.'); }

    const sum = ensureErrorSummary(); sum.textContent = ok ? '' : `Please fix: ${problems.join(', ')}.`;
    if(!ok && first[0]) scrollFocus(first[0]);
    return ok;
  }

  // live clear & sound test
  const testBtn = $('vc-test-tone');
  const toast = $('vc-toast');
  const speakerIcon = document.querySelector('.vc-sound-tip .vc-speaker');

  const showToast = (msg) => { if(!toast) return; toast.textContent = msg; toast.classList.add('is-show'); setTimeout(()=>toast.classList.remove('is-show'),1400); };
  const showSnack = (msg) => { if(!$('vc-snackbar')) return; $('vc-snackbar').textContent = msg; $('vc-snackbar').classList.add('is-show'); setTimeout(()=>$('vc-snackbar').classList.remove('is-show'),1400); };

  nameIn?.addEventListener('input', () => { if ((nameIn.value||'').trim().length>=2){ clearError(nameIn); validateForm(false); } });
  toneSel?.addEventListener('change', () => { clearError(toneSel); validateForm(false); if (!toneSel.value || isRinging) return; startRingtone(toneSel.value, { preview: true }); });
  testBtn?.addEventListener('click', async () => {
    speakerIcon?.classList.add('ringing');
    try { await startRingtone(toneSel.value, { preview: true }); showToast('Playing test tone'); }
    catch { showToast('Sound blocked—tap “Ring Now” or adjust volume'); }
    finally { setTimeout(() => speakerIcon?.classList.remove('ringing'), 2000); }
  });

  // ------- theme swatches -------
  (function setupThemeSwatches(){
    const swatches = byQSA('.swatch');
    function applyTheme(cls){
      if (themeSel) themeSel.value = cls;
      [incoming, incall, ended].forEach(el => { if (!el) return; el.classList.remove(...REMOVE_THEME_CLASSES); el.classList.add(cls); });
      const cfg = loadCfg(); saveCfg({ ...cfg, theme: cls });
    }
    function markActive(btn){
      swatches.forEach(b => { b.classList.remove('is-active'); b.setAttribute('aria-checked','false'); });
      btn.classList.add('is-active'); btn.setAttribute('aria-checked','true');
    }
    swatches.forEach(btn => {
      btn.setAttribute('role','radio'); btn.setAttribute('aria-checked','false'); btn.tabIndex = 0;
      btn.addEventListener('click', () => {
        markActive(btn);
        requestAnimationFrame(() => applyTheme(btn.dataset.theme));
        clearError(byQS('.swatches')); validateForm(false);
      });
      btn.addEventListener('keydown', (e) => { if (e.key==='Enter'||e.key===' '){ e.preventDefault(); btn.click(); } });
    });
    // One-time migration: if saved theme is unknown/legacy, switch to orange
  (() => {
    const cfg = loadCfg();
    if (cfg.theme && !VALID_THEMES.includes(cfg.theme)) {
      cfg.theme = 'vc-theme-orange';
      saveCfg(cfg);
    }
  })();
    const initial = loadCfg().theme || themeSel?.value || swatches[0]?.dataset.theme || 'vc-theme-pink';
    applyTheme(initial);
    const active = swatches.find(b => b.dataset.theme === initial) || swatches[0];
    if (active) markActive(active);
  })();

  // ------- delay segmented control -> select sync -------
  (function setupDelaySeg(){
    byQSA('.seg__input[name="vc-delay-r"]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked && delaySel){ delaySel.value = r.value; clearError(byQS('.seg')); validateForm(false); }
      });
    });
  })();

  // ------- media handling (image sets avatar) -------
  (function setupMediaInput(){
    const labelName = $('vc-media-name');
    mediaInp?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (labelName) labelName.textContent = f?.name || 'No file chosen';
      clearError(mediaInp);
      if (!f){ validateForm(false); return; }

      const objURL = URL.createObjectURL(f);
      if (f.type.startsWith('image/')){
        selectedAvatar = objURL;
        setAvatarOnAll(objURL);
        clearError(avatarGrid);
      }
      validateForm(false);
    });
  })();
  function setAvatarOnAll(src){ avatarImgs.forEach(img => { if (img) img.src = src; }); }

  // ------- avatar grid -------
  (function setupAvatarGrid(){
    const grid = avatarGrid; if (!grid) return;
    const urls = (window.VC_AVATARS || []).slice(0, 10);
    urls.forEach((src, i) => {
      const btn = document.createElement('button');
      btn.type='button'; btn.className='av-btn';
      btn.setAttribute('role','option'); btn.setAttribute('aria-selected','false');
      btn.setAttribute('aria-label',`Avatar ${i+1}`);
      const img = document.createElement('img'); img.src=src; img.alt=`Avatar ${i+1}`; img.loading='lazy';
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        byQSA('.av-btn[aria-selected="true"]', grid).forEach(b => b.setAttribute('aria-selected','false'));
        btn.setAttribute('aria-selected','true');
        btn.classList.remove('is-picking'); void btn.offsetWidth; btn.classList.add('is-picking');
        selectedAvatar = src;
        setAvatarOnAll(src);
        clearError(grid); validateForm(false);
      });
      grid.appendChild(btn);
    });
    ringNowBtn?.addEventListener('click', () => {
      const picked = byQS('.av-btn[aria-selected="true"]', grid);
      if (picked){ picked.classList.remove('is-picking'); void picked.offsetWidth; picked.classList.add('is-picking'); }
    });
  })();

  // ------- Record button nudge/glow helpers -------
  let nudgeTO = null;
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  function showRecordNudgeOnce(){
    if (!recordBtn) return;
    recordBtn.classList.add('glow');
    if (prefersReduced || localStorage.getItem('vc.tapHintShown')) return;
    recordBtn.classList.add('nudge');
    if (nudgeTO) clearTimeout(nudgeTO);
    nudgeTO = setTimeout(() => recordBtn?.classList.remove('nudge'), 5000);
    localStorage.setItem('vc.tapHintShown', '1');
  }
  function clearRecordNudge(){
    if (!recordBtn) return;
    recordBtn.classList.remove('nudge');
    if (nudgeTO) { clearTimeout(nudgeTO); nudgeTO = null; }
  }
  function setRecordIdleGlow(on){
    if (!recordBtn) return;
    recordBtn.classList.toggle('glow', !!on);
  }

  // ------- incoming UI -------
  function showIncoming(cfg){
    [incoming, incall, ended].forEach(el=>el.classList.add('d-none'));
    incoming.classList.remove('d-none');

    const theme = cfg.theme || 'vc-theme-pink';
    [incoming, incall, ended].forEach(el => { if (!el) return; el.classList.remove(...REMOVE_THEME_CLASSES); el.classList.add(theme); });

    const caller = cfg.name || 'Unknown';
    callerLbl.textContent = caller;
    titleName.textContent = caller;
    if (endedName) endedName.textContent = caller;

    const avatar = selectedAvatar || cfg.avatar || '';
    if (avatar) setAvatarOnAll(avatar);

    startRingtone(cfg.tone);
    if ('vibrate' in navigator) navigator.vibrate([300,120,300,120,300]);
  }

  // ------- ended UI -------
  function showEnded(seconds = 0){
    stopRingtone();
    [incoming, incall].forEach(el=>el.classList.add('d-none'));
    if (endedTime) endedTime.textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    const cls = themeSel?.value || loadCfg().theme || 'vc-theme-pink';
    [incoming, incall, ended].forEach(el => { if (!el) return; el.classList.remove(...REMOVE_THEME_CLASSES); el.classList.add(cls); });
    ended.classList.remove('d-none');
    ended.setAttribute('aria-hidden', 'false');

    flushPendingRecents();
    openRecModal();

    if (endedTO) { clearTimeout(endedTO); endedTO = null; }
  }

  // ------- call flow -------
  function startCall(){
    stopRingtone();
    incoming.classList.add('d-none');
    incall.classList.remove('d-none');

    showRecordNudgeOnce();

    startTs = Date.now();
    clearInterval(timerInt);
    timerInt = setInterval(() => {
      const s = Math.floor((Date.now()-startTs)/1000);
      timerLbl.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    }, 500);

    (async () => {
      try {
        if (!selfStream) {
          selfStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        }
      } catch (err) {
        console.warn('Mic capture failed:', err);
        showToast('Microphone blocked. Recording unavailable.');
      }
    })();
  }

  function endCall(){
    try { endSfx.currentTime = 0; endSfx.play().catch(()=>{}); } catch {}
    try { if (isRecording) { mediaRecorder?.stop(); isRecording = false; } } catch {}

    // FIX: release microphone tracks when the call ends
    try { selfStream?.getTracks?.().forEach(t => t.stop()); } catch {}
    selfStream = null;

    recordBtn?.classList.remove('is-recording');
    recordingIndicator?.classList.add('hidden');
    clearRecordNudge();
    setRecordIdleGlow(false);

    clearInterval(timerInt);
    const secs = startTs ? Math.floor((Date.now() - startTs)/1000) : 0;
    startTs = null;
    timerLbl.textContent = '00:00';

    incall.classList.add('d-none');
    showEnded(secs);
  }

  // ------- modal controls -------
  let lastFocus = null;

  function wireModalHandlers(){
    recModal       = $('vc-rec-modal');
    recModalClose  = $('vc-rec-close');
    recModalBack   = $('vc-rec-back');
    recModalList   = $('vc-recents-modal-list');

    recModalClose?.addEventListener('click', closeRecModal);
    byQS('.vc-rec-modal__backdrop')?.addEventListener('click', closeRecModal);
    recModalBack?.addEventListener('click', () => {
      closeRecModal();
      ended.classList.add('d-none');
      ended.setAttribute('aria-hidden','true');
      [incoming, incall].forEach(el=>el.classList.add('d-none'));
      (ringNowBtn || scheduleBtn || nameIn)?.focus?.();
      showToast('Back to setup');
    });
  }
  wireModalHandlers();

  function openRecModal(){
    ensureRecentsEls();
    if (!recModal) return;

    const hasRealItems   = !!recModalList.querySelector('.vc-rec-item:not(.vc-rec-empty)');
    const existingEmpty  = recModalList.querySelector('.vc-rec-empty');

    if (hasRealItems) {
      existingEmpty?.remove();
      showRecSubtitle();
    } else {
      if (!existingEmpty) {
        const emp = document.createElement('div');
        emp.className = 'vc-rec-empty vc-rec-item';
        emp.innerHTML = `<div class="vc-rec-meta">No recordings from this call.</div>`;
        recModalList.appendChild(emp);
      }
      hideRecSubtitle();
    }

    recModal.classList.remove('d-none');
    document.body.classList.add('is-modal-open');
    lastFocus = document.activeElement;
    (recModalClose || recModal).focus?.();

    const onKey = (e) => {
      if (e.key === 'Escape') closeRecModal();
      if (e.key === 'Tab') {
        const focusables = byQSA('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', recModal)
          .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    recModal._onKey = onKey;
    window.addEventListener('keydown', onKey);
  }

  function closeRecModal(){
    if (!recModal) return;
    recModal.classList.add('d-none');
    document.body.classList.remove('is-modal-open');
    if (recModal._onKey) { window.removeEventListener('keydown', recModal._onKey); delete recModal._onKey; }
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  // ------- extra fallback: tap the red ✕ to go back -------
  byQS('#vc-ended .vc-ended-icon')?.addEventListener('click', () => {
    if (recModal && !recModal.classList.contains('d-none')) {
      closeRecModal();
    } else {
      ended.classList.add('d-none');
      ended.setAttribute('aria-hidden','true');
      (ringNowBtn || scheduleBtn || nameIn)?.focus?.();
    }
  });

  // ------- controls -------
  acceptBtn?.addEventListener('click', startCall);
  declineBtn?.addEventListener('click', () => showEnded(0));
  endBtn?.addEventListener('click', endCall);

  // recording logic
  recordBtn?.addEventListener('click', async () => {
    if (isRecording) {
      try { mediaRecorder?.stop(); } catch {}
      isRecording = false;
      recordBtn.classList.remove('is-recording');
      recordingIndicator?.classList.add('hidden');
      setRecordIdleGlow(true);
      return;
    }
    try {
      if (!selfStream) {
        selfStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      }

      recChunks = [];
      const mimeType = pickAudioMime();
      mediaRecorder = new MediaRecorder(selfStream, mimeType ? { mimeType } : undefined);

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };

      mediaRecorder.onstop = () => {
        const type = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(recChunks, { type });
        const url  = URL.createObjectURL(blob);

        const whenDate = new Date();
        const whenIso = whenDate.toISOString().replace(/[:.]/g, '-');
        const whenHuman = whenDate.toLocaleString();
        const who  = (titleName?.textContent || 'caller').trim() || 'caller';

        let ext = 'webm';
        if (type.includes('mp4')) ext = 'mp4';
        else if (type.includes('aac')) ext = 'aac';

        const filename = `call-recording_${who}_${whenIso}.${ext}`;

        // Auto download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 0);

        addRecentRecording({ url, filename, whenHuman });
        showSnack('Recording downloaded');

        if (!ended || ended.classList.contains('d-none')) {
          setRecordIdleGlow(true);
        }
      };

      mediaRecorder.start(1000);
      isRecording = true;
      recordBtn.classList.add('is-recording');
      recordingIndicator?.classList.remove('hidden');

      clearRecordNudge();
      setRecordIdleGlow(false);

    } catch (err) {
      console.error('Recording failed:', err);
      showToast('Recording unavailable (permissions or browser).');
    }
  });

  // ------- schedule / ring now -------
  function cfgFromUI(){
    return { name: nameIn?.value?.trim(), tone: toneSel?.value, theme: themeSel?.value, avatar: selectedAvatar || '' };
  }
  window.addEventListener('beforeunload', () => {
  cancelScheduledCall();
});


  scheduleBtn?.addEventListener('click', () => {
    if (!validateForm(true)) return;

    // persist config so setTimeout uses the latest
    const cfg = cfgFromUI(); saveCfg(cfg);

    // compute when
    const delaySec = Math.max(0, parseInt(delaySel.value || '0', 10));
    const when = new Date(Date.now() + delaySec * 1000);

    // show confirmation modal with clock gif
    openScheduleModal(when);

    // if there was a previous schedule, clear it
    cancelScheduledCall();

    // schedule the incoming screen
    scheduleTimeout = setTimeout(() => {
      closeScheduleModal();
      showIncoming(loadCfg());
    }, delaySec * 1000);
  });




  ringNowBtn?.addEventListener('click', () => {
    if (!validateForm(true)) return;
    cancelScheduledCall();
    const cfg = cfgFromUI(); saveCfg(cfg);
    showIncoming(cfg);
  });

  // ------- util -------
  function pickAudioMime(){
    const prefs = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',   // Safari
      'audio/aac'
    ];
    for (const t of prefs){
      if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return '';
  }
})();
