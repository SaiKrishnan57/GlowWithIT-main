// Hazard reporting with gentle pulse + amber glow (no ring)
export function createGlowReporter({
  map,
  reportBtn,

  emojiUrl = '/static/images/ghost.png',
  onConfirm,                  
  setLayersVisible,           
  getLayersVisible,           
  ttlSecs = 1800,            
  pulseMs = 1500              
}) {


  let reportMode = false;
  let prevLayers = { venues: true, lighting: true };

  let _hzGhost = null;          // preview marker
  let _hzGhostMoveL = null;     // map mousemove listener
  let _hzGhostClickL = null;    // map click listener
  let _hzGhostFrozen = false;   // true after click-to-place
  let _hzIW = null;             // InfoWindow for confirm/cancel

  // HUD this would only appears in report mode
  let _hud = null;
  let _selectedKind = 'general';
  let _selectedTTL  = 1800;     // 30m by default

  // Active hazards
  const _hazards = new Map();
  let _tickId = null;

  // hazard kinds
  const KIND_ICON = {
    general:     { label: 'General',     icon: '/static/images/ghost.png' },
    brokenLight: { label: 'Broken Light', icon: '/static/images/hz-bat.png' },
    harassment:  { label: 'Harassment',  icon: '/static/images/hz-pumpkin.png' },
  };
  const KIND_ORDER = ['general','brokenLight','harassment'];
  function iconForKind(kind) {
    return KIND_ICON[kind]?.icon || emojiUrl;
  }

  // --- CSS once ---
  (function ensureCss() {
    if (document.getElementById('gw-ghost-css')) return;
    const s = document.createElement('style');
    s.id = 'gw-ghost-css';
    s.textContent = `
      .gw-ghost{
        position:relative;border-radius:14px;display:grid;place-items:center;
        background:#ffffff;color:#111;border:2px solid #fff;
        box-shadow:0 0 0 2px #fff,0 6px 18px rgba(245,158,11,.35),0 0 0 10px rgba(245,158,11,.16);
        opacity:.96;user-select:none;font-size:18px;line-height:1;
        transition:transform .14s ease,box-shadow .14s ease,opacity .14s;
      }
      .gw-ghost-pulse{animation:gwGhostPulse var(--pulseMs,1500ms) ease-in-out 1;}
      @keyframes gwGhostPulse {
        0%{transform:scale(1);box-shadow:0 0 0 2px #fff,0 6px 18px rgba(245,158,11,.35),0 0 0 10px rgba(245,158,11,.10);}
        50%{transform:scale(1.06);box-shadow:0 0 0 2px #fff,0 8px 22px rgba(245,158,11,.40),0 0 0 12px rgba(245,158,11,.16);}
        100%{transform:scale(1);box-shadow:0 0 0 2px #fff,0 6px 18px rgba(245,158,11,.35),0 0 0 10px rgba(245,158,11,.16);}
      }
      .gw-chip{
        position:absolute;left:50%;transform:translateX(-50%);bottom:-28px;
        background:rgba(17,19,27,.92);color:#fff;border-radius:999px;
        padding:4px 8px;font:600 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        box-shadow:0 6px 18px rgba(0,0,0,.25);display:none;white-space:nowrap;
      }
      .gw-ghost:hover + .gw-chip, .gw-ghost:focus-visible + .gw-chip{display:block;}
      @media (prefers-reduced-motion: reduce){ .gw-ghost-pulse{animation:none!important;} }
    `;
    document.head.appendChild(s);
  })();

  // ----- Constants -----
  const GHOST_SIZE_PX  = 48;
  const HAZARD_SIZE_PX = 48;
  function nowSec() { return Math.floor(Date.now()/1000); }


  function ensureHazardHUD() {
    let hud = document.getElementById('hz-hud');
    if (hud) return hud;

    hud = document.createElement('div');
    hud.id = 'hz-hud';
    hud.style.cssText = `
    position:absolute; right:12px; bottom:12px; z-index:5;
    display:none; gap:10px; padding:10px; border-radius:14px;

   
    background: linear-gradient(180deg, #e2c6f0 0%, #d9b2eb 100%);
    border: 1px solid rgba(26,16,34,.15);                 
    box-shadow:
      0 10px 26px rgba(0,0,0,.22),                      
      inset 0 1px 0 rgba(255,255,255,.55),                
      inset 0 -1px 0 rgba(26,16,34,.08);                 
    backdrop-filter: saturate(1.15) blur(6px);

    color:#1a1022;                                       
    font:600 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  `;

    const kindBtns = KIND_ORDER.map(k => {
      const meta = KIND_ICON[k] || {};
      const lbl  = meta.label || k;
      const ico  = meta.icon  || '/static/images/ghost.png';
      return `
        <button class="hz-kind btn " data-kind="${k}" title="${lbl}" aria-label="${lbl}">
          <img class="hz-kind-img" src="${ico}" alt="${lbl}" width="18" height="18">
        </button>`;
    }).join('');

    hud.innerHTML = `
      <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
        <span style="opacity:.85">Hazard</span>
        ${kindBtns}
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <span style="opacity:.85">Expires</span>
        <button class="hz-ttl btn" data-ttl="900">15m</button>
        <button class="hz-ttl btn" data-ttl="1800">30m</button>
        <button class="hz-ttl btn" data-ttl="3600">60m</button>
      </div>
    `;

    hud.querySelectorAll('.btn').forEach(b => {

      b.style.cssText = `
        border:1px solid rgba(26,16,34,.18);
        border-radius:12px; padding:8px 10px; min-width:58px;
        background: linear-gradient(180deg, rgba(26,16,34,.06), rgba(26,16,34,.10));
        color:#1a1022; cursor:pointer;
        box-shadow:
          0 1px 1px rgba(0,0,0,.08),
          inset 0 1px 0 rgba(255,255,255,.35);              /* inner highlight */
        transition: transform .06s ease, background .15s ease, box-shadow .15s ease;
      `;
      b.addEventListener('mouseenter', () => {
        b.style.background = 'linear-gradient(180deg, rgba(26,16,34,.10), rgba(26,16,34,.16))';
        b.style.boxShadow  = '0 2px 6px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.35)';
      });
      b.addEventListener('mouseleave', () => {
        const isActive = b.classList.contains('active');
        b.style.background = isActive
          ? 'linear-gradient(180deg, rgba(26,16,34,.14), rgba(26,16,34,.20))'
          : 'linear-gradient(180deg, rgba(26,16,34,.06), rgba(26,16,34,.10))';
        b.style.boxShadow  = isActive
          ? '0 1px 3px rgba(0,0,0,.10), inset 0 1px 0 rgba(255,255,255,.35)'
          : '0 1px 1px rgba(0,0,0,.08), inset 0 1px 0 rgba(255,255,255,.35)';
      });
    });

    hud.querySelectorAll('.hz-kind.btn').forEach(b => {

        b.style.padding = '0';
        b.style.minWidth = 'unset';
        b.style.width = '48px';     
        b.style.height = '36px';
        b.style.display = 'grid';
        b.style.placeItems = 'center';
    });

 
    hud.querySelectorAll('.hz-kind-img').forEach(img => {
      img.style.width = '22px';
      img.style.height = '22px';
      img.style.display = 'block';
    });


    
    

    map.getDiv().appendChild(hud);
    return hud;
  }

  function showHUD() {

    _hud = ensureHazardHUD();
    _hud.style.display = 'grid';
    if (!_selectedTTL) _selectedTTL = 1800;
    if (!_selectedKind) _selectedKind = 'general';
    highlightHUD();

    _hud.querySelectorAll('.hz-kind').forEach(b => {
      b.onclick = () => { _selectedKind = b.dataset.kind; highlightHUD(); updateGhostPreviewIcon(); };
    });
    _hud.querySelectorAll('.hz-ttl').forEach(b => {
      b.onclick = () => { _selectedTTL = Number(b.dataset.ttl); highlightHUD(); };
    });
  }

  function hideHUD() { if (_hud) _hud.style.display = 'none'; }

  function highlightHUD() {

    if (!_hud) return;
    _hud.querySelectorAll('.hz-kind,.hz-ttl').forEach(b => {
      const active = (b.classList.contains('hz-kind') && b.dataset.kind === _selectedKind)
                  || (b.classList.contains('hz-ttl')  && Number(b.dataset.ttl) === _selectedTTL);
      b.classList.toggle('active', active);
      b.style.background = active ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.06)';
    });
  }


  function buildGhostEl(kind = _selectedKind) {
    const el = document.createElement('div');
    el.className = 'gw-ghost gw-ghost-pulse';
    const url = iconForKind(kind);
    el.style.cssText = `
      --pulseMs:${pulseMs}ms;
      width:${GHOST_SIZE_PX}px; height:${GHOST_SIZE_PX}px; border-radius:14px;
      display:grid; place-items:center; background:#ffffff; color:#111; border:2px solid #fff;
      background-image:url('${url}'); background-repeat:no-repeat; background-position:center; background-size:70% 70%;
    `;
    const img = new Image();
    img.onerror = () => { el.style.backgroundImage = 'none'; el.textContent = KIND_ICON[kind]?.fallback || '👻'; };
    img.src = url;
    return el;
  }

  function beginGhostPreview() {

    if (_hzGhost || _hzGhostMoveL) return;
    map.setOptions({ draggableCursor: 'crosshair' });

    if (google.maps.marker?.AdvancedMarkerElement) {
      _hzGhost = new google.maps.marker.AdvancedMarkerElement({
        map, position: map.getCenter(), content: buildGhostEl(),
        zIndex: google.maps.Marker.MAX_ZINDEX + 5, title: 'Place hazard'
      });
    } else {
      _hzGhost = new google.maps.Marker({
        map, position: map.getCenter(), title: 'Place hazard',
        zIndex: google.maps.Marker.MAX_ZINDEX + 5,
        icon: {
          url: iconForKind(_selectedKind),
          scaledSize: new google.maps.Size(GHOST_SIZE_PX, GHOST_SIZE_PX),
          anchor: new google.maps.Point(GHOST_SIZE_PX/2, GHOST_SIZE_PX/2)
        }
      });
    }

    _hzGhostMoveL = map.addListener('mousemove', (e) => {
      if (_hzGhostFrozen) return;
      const pos = e.latLng;
      if (_hzGhost.position !== undefined) _hzGhost.position = pos;
      else _hzGhost.setPosition(pos);
    });

    _hzGhostClickL = map.addListener('click', (e) => {
      if (_hzGhostFrozen) return;
      _hzGhostFrozen = true;
      const pos = e.latLng;
      if (_hzGhost.position !== undefined) _hzGhost.position = pos;
      else _hzGhost.setPosition(pos);
      openGhostConfirmAt(pos);
    });
  }
  function updateGhostPreviewIcon() {
    if (!_hzGhost) return;
    const el = buildGhostEl(_selectedKind);
    if (_hzGhost.content !== undefined) {
      _hzGhost.content = el;        
    } else if (_hzGhost.setIcon) {
      _hzGhost.setIcon({
        url: iconForKind(_selectedKind),
        scaledSize: new google.maps.Size(GHOST_SIZE_PX, GHOST_SIZE_PX),
        anchor: new google.maps.Point(GHOST_SIZE_PX/2, GHOST_SIZE_PX/2)
      });
    }
  }
  function endGhostPreview() {
    map.setOptions({ draggableCursor: null });
    _hzGhostFrozen = false;
    if (_hzGhostMoveL) { google.maps.event.removeListener(_hzGhostMoveL); _hzGhostMoveL = null; }
    if (_hzGhostClickL) { google.maps.event.removeListener(_hzGhostClickL); _hzGhostClickL = null; }
    if (_hzGhost) {
      (_hzGhost.map !== undefined) ? (_hzGhost.map = null) : _hzGhost.setMap(null);
      _hzGhost = null;
    }
    if (_hzIW) { _hzIW.close(); _hzIW = null; }
  }

  // ---------- Marker UI ----------
  function formatRemaining(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec >= 3600) {
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return `${h}h ${m}m left`;
    }
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m left` : `${s}s left`;
  }

  function buildHazardContent(ttlSeconds, kind='general') {
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:relative;width:${HAZARD_SIZE_PX}px;height:${HAZARD_SIZE_PX}px;`;

    const ghost = document.createElement('div');
    ghost.className = 'gw-ghost gw-ghost-pulse';
    ghost.style.cssText = `
      --pulseMs:${pulseMs}ms;
      width:${HAZARD_SIZE_PX}px;height:${HAZARD_SIZE_PX}px;border-radius:14px;
      display:grid;place-items:center;background:#ffffff;border:2px solid #fff;
      background:url('${iconForKind(kind)}') center/70% 70% no-repeat;
    `;

    const img = new Image();
    img.onerror = () => { ghost.style.background='none'; ghost.textContent = KIND_ICON[kind]?.fallback || '👻'; };
    img.src = iconForKind(kind);

    const chip = document.createElement('div');
    chip.className = 'gw-chip';
    chip.textContent = formatRemaining(ttlSeconds);

    wrap.appendChild(ghost);
    wrap.appendChild(chip);
    setTimeout(() => ghost.classList.remove('gw-ghost-pulse'), pulseMs + 60);

    return { wrap, ghost, chip };
  }

  function placeHazardMarker(latLng, ttlSeconds = ttlSecs, kind='general') {
    const createdAt = nowSec();
    const pos = (latLng && typeof latLng.lat === 'function') ? latLng : new google.maps.LatLng(latLng.lat, latLng.lng);

    if (google.maps.marker?.AdvancedMarkerElement) {
      const ui = buildHazardContent(ttlSeconds, kind);
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map, position: pos, content: ui.wrap,
        title: KIND_ICON[kind]?.label || 'Reported hazard',
        zIndex: google.maps.Marker.MAX_ZINDEX + 8
      });
      const id = `${createdAt}-${Math.random().toString(36).slice(2,8)}`;
      _hazards.set(id, {
        id, marker, createdAt, ttlSecs: ttlSeconds, ui, kind,
        remove: () => { marker.map = null; _hazards.delete(id); }
      });
      ensureScheduler();
      return id;
    }

    // Classic marker fallback
    const marker = new google.maps.Marker({
      map, position: pos, title: KIND_ICON[kind]?.label || 'Reported hazard',
      zIndex: google.maps.Marker.MAX_ZINDEX + 8,
      icon: {
        url: iconForKind(kind),
        scaledSize: new google.maps.Size(HAZARD_SIZE_PX, HAZARD_SIZE_PX),
        anchor: new google.maps.Point(HAZARD_SIZE_PX/2, HAZARD_SIZE_PX/2)
      }
    });
    const id = `${createdAt}-${Math.random().toString(36).slice(2,8)}`;
    _hazards.set(id, {
      id, marker, createdAt, ttlSecs: ttlSeconds, ui: { chip: null }, kind,
      remove: () => { marker.setMap(null); _hazards.delete(id); }
    });
    ensureScheduler();
    return id;
  }

  function ensureScheduler() {
    if (_tickId) return;
    _tickId = setInterval(() => {
      if (_hazards.size === 0) { clearInterval(_tickId); _tickId = null; return; }
      const t = nowSec();
      for (const [, h] of _hazards) {
        const elapsed = t - h.createdAt;
        const remain  = Math.max(0, h.ttlSecs - elapsed);
        if (h.ui?.chip) h.ui.chip.textContent = formatRemaining(remain);
        if (remain <= 60) {
          const el = h.marker?.content;
          if (el) el.style.opacity = remain % 2 ? 0.85 : 1.0;
        }
        if (remain <= 0) h.remove();
      }
    }, 1000);
  }

  // Confirm UI (prefilled from HUD) 
  function openGhostConfirmAt(latLng) {
    if (!_hzIW) _hzIW = new google.maps.InfoWindow({ maxWidth: 320 });
    _hzIW.setPosition(latLng);

    const kindOptions = KIND_ORDER.map(k => `<option value="${k}">${KIND_ICON[k].label}</option>`).join('');

    _hzIW.setContent(`
      <div style="font:600 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
        <div style="margin-bottom:.5rem">Place hazard icon here?</div>

        <div class="row g-2" style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap">
          <label class="form-label mt-2" style="margin:0;">Hazard:</label>
          <select id="hz-kind" class="form-select form-select-sm" style="width:auto;">
            ${kindOptions}
          </select>

          <div style="flex:1"></div>

          <label class="form-label mt-2" style="margin:0;">Expires:</label>
          <select id="hz-ttl" class="form-select form-select-sm" style="width:auto;">
            <option value="900">15 min</option>
            <option value="1800">30 min</option>
            <option value="3600">60 min</option>
          </select>

          <div style="flex:1"></div>
          <button id="hz-confirm" class="btn btn-sm btn-warning">Confirm</button>
          <button id="hz-cancel"  class="btn btn-sm btn-outline-light">Cancel</button>
        </div>
      </div>
    `);
    _hzIW.open({ map });

    google.maps.event.addListenerOnce(_hzIW, 'domready', () => {
      const root = _hzIW.getContentElement?.() || null;
      const q = (sel) => root ? root.querySelector(sel) : document.querySelector(sel);

      // Prefill from HUD selections
      q('#hz-kind').value = _selectedKind || 'general';
      q('#hz-ttl').value  = String(_selectedTTL || ttlSecs);

      const closeAndThaw = () => { _hzIW.close(); _hzGhostFrozen = false; };
      q('#hz-cancel')?.addEventListener('click', closeAndThaw);

      q('#hz-confirm')?.addEventListener('click', async () => {
        const p = latLng;
        const lat = (typeof p.lat === 'function') ? p.lat() : p.lat;
        const lng = (typeof p.lng === 'function') ? p.lng() : p.lng;
        const kindSel = (q('#hz-kind')?.value || _selectedKind || 'general');
        const ttlSel  = Number(q('#hz-ttl')?.value || _selectedTTL || ttlSecs);

        // Optimistic add
        let id;
        try { id = placeHazardMarker({ lat, lng }, ttlSel, kindSel); } catch {}

        // Persist via callback if provided
        try {
          if (typeof onConfirm === 'function') {
            await onConfirm({ lat, lng, id, ttlSecs: ttlSel, kind: kindSel });
          }
        } catch {
          // optional toast if you have one globally
          if (typeof window.showToast === 'function') window.showToast('Saved locally. Network issue.');
        }

        _hzIW.close();
        exitReportMode();
      });

      q('#hz-confirm')?.focus({ preventScroll: true });
    });

    google.maps.event.addListenerOnce(_hzIW, 'closeclick', () => { _hzGhostFrozen = false; });
  }

  // ---------- Mode switches ----------
  function setReportBtnState(active) {
    if (!reportBtn) return;
    const label = reportBtn.querySelector('.label') || reportBtn;
    const ico   = reportBtn.querySelector('.ico');
    label.textContent = active ? 'Cancel' : 'Report';
    reportBtn.classList.toggle('btn-warning', !active);
    reportBtn.classList.toggle('btn-outline-light', active);
    if (ico) ico.src = active ? '/static/images/close-16.png' : '/static/images/icons8-warning-100.png';
  }

  function enterReportMode() {
    if (reportMode) return;
    if (!map || !google?.maps) { console.warn('Map not ready'); return; }
    reportMode = true;
    showHUD();                          // show compact HUD only in report mode
    prevLayers = getLayersVisible ? getLayersVisible() : { venues: true, lighting: true };
    setLayersVisible?.({ venues: false, lighting: false });
    beginGhostPreview();
    setReportBtnState(true);
  }

  function exitReportMode() {
    if (!reportMode) return;
    reportMode = false;
    hideHUD();
    setLayersVisible?.(prevLayers);
    endGhostPreview();
    setReportBtnState(false);
  }

  // Wire the button (guard against <form> submit)
  reportBtn?.addEventListener('click', (e) => {
    e?.preventDefault?.();
    (reportMode ? exitReportMode : enterReportMode)();
  });

  
  return {
    enterReportMode,
    exitReportMode,
    beginGhostPreview,
    endGhostPreview,
    isReporting: () => reportMode,

    // expose for a future sync module if you add server polling
    __placeHazardMarker: (pos, ttl, kind) => placeHazardMarker(pos, ttl, kind),
    _hazards
  };
}
