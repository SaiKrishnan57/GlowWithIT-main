  window.initGlowMap = function () {
  
      //Check if the js successfully get the data from data/lighting.geojson
      
      //localStorage.removeItem('gw:lighting:data/lighting.geojson');

      const SIMPLE_GEO = true;
      const SHOW_USER_LOCATION = true;
      const now = () => Date.now();
      function cacheGet(k) {
        try {
          const raw = localStorage.getItem(k);
          if (!raw) return null;
          const { t, ttl, v } = JSON.parse(raw);
          if (!t || !ttl || (now() - t) > ttl) { localStorage.removeItem(k); return null; }
          return v;
        } catch { return null; }
      }
      function cacheSet(k, v, ttlMs) {
        try { localStorage.setItem(k, JSON.stringify({ t: now(), ttl: ttlMs, v })); } catch {}
      }
      async function fetchWithCache(url, { key, ttlMs = 3600_000, fetchInit } = {}) {
        const k = key || `gw:cache:${url}`;
        const cached = cacheGet(k);
        if (cached) return { ok: true, fromCache: true, json: async () => cached };

        const res = await fetch(url, fetchInit || { headers: { Accept: 'application/json' } });
        if (res.ok) {
          try {
            const data = await res.json();
            cacheSet(k, data, ttlMs);
            return { ok: true, fromCache: false, json: async () => data };
          } catch { /* fall through */ }
        }
        return res;
      }





    // Guard: don't run twice
    if (window.__initGlowMap_ran) return;

    // Make sure the DOM node exists and Maps API is loaded BEFORE marking as "ran"
    const mapEl = document.getElementById('map');
    if (!mapEl || !window.google?.maps) {
      
      return;
    }

    

    // From here we consider initialization successful.
    window.__initGlowMap_ran = true;

    const mapId = mapEl?.dataset.mapId || null;

    // Feature flags
    const USE_ROUTE_SCORE = true;
    const MELBOURNE_CENTRAL = { lat: -37.8109, lng: 144.9629 };

    // ---- MarkerClusterer loader (UMD) ----
    async function ensureClustererLib() {
      // If any known global is already there, we're good
      if (
        (window.markerClusterer && (window.markerClusterer.MarkerClusterer || window.markerClusterer.default)) ||
        (window.MarkerClusterer && (window.MarkerClusterer.MarkerClusterer || typeof window.MarkerClusterer === 'function'))
      ) return;

      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/@googlemaps/markerclusterer/dist/index.min.js';
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    // Map
    const map = new google.maps.Map(mapEl, {
      center: { lat: -37.8100, lng: 144.9633 },
      zoom: 14,
      mapTypeId: 'roadmap',
      clickableIcons: true,
      ...(mapId ? { mapId } : {})
    });

    map.addListener('click', () => { deselectVenueMarker(); venueIW?.close(); });

    // Handle tab visibility restore; force a resize to avoid blank tiles
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        try { google.maps.event.trigger(map, 'resize'); } catch(_) {}
      }
    });


    // ----- Shared state (declared early to avoid TDZ issues) -----
    let originLatLng = null, destLatLng = null;
    let lastQuery = null;
    window.__userHasStart = false;
    const state = { lighting: true, venues: true };

    // ----- Location prompt & goTo helpers -----
    {
      const promptEl = document.getElementById('svm-loc-prompt');
      const btnAllow = document.getElementById('svm-allow');
      const btnSkip  = document.getElementById('svm-skip');
      const hidePrompt = () => {
        if (!promptEl) return;
        // Remove the card completely so it can’t overlay/affect layout
        promptEl.remove();

        // After layout settles, tell Maps to recompute and repaint
        requestAnimationFrame(() => {
          try { google.maps.event.trigger(map, 'resize'); } catch (_) {}
        });
      };

      function hardCenter(pos, zoom = 16) {
        map.setCenter(pos);
        map.setZoom(zoom);
      }

      // --- live "you" updates ---
      let _geoWatchId = null;
      function startLiveYou() {

        if (!SHOW_USER_LOCATION || SIMPLE_GEO) return; 
        if (!navigator.geolocation) return;
        if (_geoWatchId) return; // already watching
        _geoWatchId = navigator.geolocation.watchPosition(
          (p) => {
            const { latitude, longitude, accuracy, heading } = p.coords || {};
            if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
              putUserMarker(latitude, longitude, { accuracy, heading });
            }
          },
          () => {}, // ignore transient errors
          { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
        );
      }
      function stopLiveYou() {

        if (_geoWatchId) { navigator.geolocation.clearWatch(_geoWatchId); _geoWatchId = null; }
      }


      let hasActiveRoute = false;
      function setRoutePresence(on) {
        hasActiveRoute = !!on;
        // Only touch user marker / geolocation if the feature is enabled and we’re not in SIMPLE_GEO
       if (SHOW_USER_LOCATION && !SIMPLE_GEO) {
         // hide the DOM marker, map accuracy disk, and ripple while a route is active
         setUserMarkerVisible(!hasActiveRoute);
         // pause/resume geolocation to avoid drift & save battery
         if (hasActiveRoute) { stopLiveYou?.(); }
         else { startLiveYou?.(); }
       }
    }

      function goTo(pos, label) {

        window.__userHasStart = true;
        hardCenter(pos, 16);
        
        if (SHOW_USER_LOCATION) {
             putUserMarker(pos.lat, pos.lng, { heading: pos.heading, accuracy: pos.accuracy });
        }
        // Resolve inputs on demand to avoid TDZ if user clicks early
        const originInputEl = document.getElementById('gw-origin');
        if (originInputEl) {
          originInputEl.value = label || 'My location';
          originLatLng = new google.maps.LatLng(pos.lat, pos.lng);
        }
        ensureCityLighting();
        if (state.venues) {
          lastQuery = null;
          searchNearbyVenues(pos.lat, pos.lng);
        }
      }

      function goToMelbourneCentral(msg){
        goTo(MELBOURNE_CENTRAL, 'Melbourne Central');
        if (msg) showToast?.(msg);
      }

      


      const insideCity = (lat, lng) => isInsideCity(new google.maps.LatLng(lat, lng));

      function focusMapAfterPrompt() {
        // Keep the map container definitely visible
        mapEl.style.visibility = 'visible';

        // Scroll the map into view (especially helpful on mobile)
        mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Give the browser one frame to reflow, then resize + recentre
        requestAnimationFrame(() => {
          try { google.maps.event.trigger(map, 'resize'); } catch(_) {}
          // Maintain current zoom while re-centering to avoid “jump to world”
          const c = map.getCenter();
          if (c) map.setCenter(c);
        });
      }


      btnAllow?.addEventListener('click', () => {

        btnAllow.disabled = true;
        btnAllow.textContent = 'Locating…';
        const done = () => { btnAllow.disabled = false; btnAllow.textContent = 'Allow Location Access'; };
        // If user-location is disabled globally, behave like Skip
        if (!SHOW_USER_LOCATION) {
            goToMelbourneCentral('Location is disabled.');
            hidePrompt(); focusMapAfterPrompt(); return done();
        }

        // No API? Fall back immediately.
        if (!navigator.geolocation) {
          goToMelbourneCentral('Geolocation unavailable. Using Melbourne Central.');
          hidePrompt(); focusMapAfterPrompt(); return done();
        }

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude: lat, longitude: lng, accuracy } = pos.coords || {};
            const valid = Number.isFinite(lat) && Number.isFinite(lng);
            const preciseEnough = (accuracy || 9999) <= 1500;

            if (!valid) {
              goToMelbourneCentral('Couldn’t read your location — using Melbourne Central.');
            } else if (!isInsideCity(new google.maps.LatLng(lat, lng))) {
              goToMelbourneCentral('You’re outside the City of Melbourne — using Melbourne Central.');
            } else if (!preciseEnough) {
              goToMelbourneCentral('Location fix is too imprecise — using Melbourne Central.');
            } else {
              goTo({ lat, lng, accuracy }, 'My location');
              startLiveYou?.();
            }

            hidePrompt();
            focusMapAfterPrompt();
            done();
          },
          () => {
            goToMelbourneCentral('Couldn’t get your location — using Melbourne Central.');
            hidePrompt();
            focusMapAfterPrompt();
            done();
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });


      btnSkip?.addEventListener('click', () => { goToMelbourneCentral(); hidePrompt();  focusMapAfterPrompt();});
    }

    // Left side panel 
    function injectSidePanelShell(){
    const panel = document.getElementById('svm-panel');
    if (!panel) return null;
    if (panel.dataset.built === '1') return panel;

    panel.innerHTML = `
      <div class="svm-panel-head">
        <div>
          <div class="svm-panel-title">Safety Map</div>
          <div class="svm-panel-meta"><span id="svm-count">0</span> safe venues in view</div>
        </div>

        <div class="svm-head-actions" style="display:flex; gap:.4rem;">
          <button id="svm-hz-report" type="button" class="btn btn-warning btn-sm" title="Report a hazard">
            <img class="ico" src="/static/images/icons8-warning-100.png" alt="" aria-hidden="true"
                style="width:16px;height:16px;object-fit:contain;vertical-align:middle;">
            <span class="label">Report</span>
          </button>
        </div>
      </div>

      <div class="svm-toolbar">
        <!-- removed: .svm-searchbox -->
        <select id="svm-show" class="form-select form-select-sm text-center" title="Show Me">
          <option value="open">Open Now</option>
          <option value="247">24/7</option>
          <option value="all" selected>All</option>
        </select>
        <select id="svm-sort" class="form-select form-select-sm text-center" title="Sort By">
          <option value="nearest" selected>Nearest</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      <div id="svm-panel-list" class="svm-vlist"></div>
      <div class="svm-showmore"><i class="bi bi-chevron-down"></i> Show More</div>
    `;
    panel.dataset.built = '1';
    return panel;
  }

  (function fixPanelToolbarOverflow(){
      if (document.getElementById('svm-toolbar-fix')) return;
      const s = document.createElement('style');
      s.id = 'svm-toolbar-fix';
      s.textContent = `
     
        #svm-panel .svm-toolbar{
          display:grid;
          grid-template-columns: 1fr 1fr;     /* two equal columns */
          gap: .5rem;
          align-items: stretch;
          width: 100%;
          box-sizing: border-box;
        }

        
        #svm-panel .svm-toolbar > *{
          min-width: 0;              /* critical: allow shrink inside grid cell */
          max-width: 100%;
        }

      
        #svm-panel .svm-toolbar .btn,
        #svm-panel .svm-toolbar button{
          width: 100%;
        }

        /* If they are <select>, force full width too */
        #svm-panel .svm-toolbar .form-select,
        #svm-panel .svm-toolbar .form-select-sm{
          width: 100% !important;
          -webkit-appearance: none;
          appearance: none;
        }

       
        #svm-panel{ overflow: hidden; }

        
        @media (max-width: 420px){
          #svm-panel .svm-toolbar{ grid-template-columns: 1fr; }
        }
      `;
      document.head.appendChild(s);
    })();

      (function compactToolbar(){
      const s = document.createElement('style');
      s.textContent = `
        .svm-toolbar{
          display:flex; align-items:center; gap:.5rem;
          padding:.35rem .5rem .5rem .5rem;
        }
        .svm-toolbar .form-select-sm{ min-width: 9.5rem; }
      `;
      document.head.appendChild(s);
    })();



    
    let panelListEl, panelCountEl, showMoreEl;

    const FIRST_PAGE = 22;
    let VISIBLE_LIMIT = FIRST_PAGE;
    const PAGE_SIZE = 12;
    const VENUE_FILTERS = { only247:false, show:"all", sort:"nearest" };

    function ensureSidePanel(){

      const panel = injectSidePanelShell();
      if (!panel) return null;

      panelListEl  = panel.querySelector('#svm-panel-list');
      panelCountEl = panel.querySelector('#svm-count');
      showMoreEl   = panel.querySelector('.svm-showmore');

      const showSel = panel.querySelector('#svm-show');
      const sortSel = panel.querySelector('#svm-sort');

      // restore UI state
      showSel.value = VENUE_FILTERS.show;
      sortSel.value = VENUE_FILTERS.sort;

      // bind once
      if (!panel.dataset.bound) {
        panel.dataset.bound = '1';

        showSel.addEventListener('change', e => {
          VENUE_FILTERS.show = e.target.value;
          VISIBLE_LIMIT = FIRST_PAGE;
          renderVenueList();
        });

        sortSel.addEventListener('change', e => {
          VENUE_FILTERS.sort = e.target.value;
          VISIBLE_LIMIT = FIRST_PAGE;
          renderVenueList();
        });

        showMoreEl?.addEventListener('click', () => {
          const cap = (typeof MAX_VENUES === 'number') ? MAX_VENUES : 500;
          VISIBLE_LIMIT = Math.min(VISIBLE_LIMIT + PAGE_SIZE, cap);
          renderVenueList();
        });
      }


      return panel;
    }


    



    function setVenuePanelVisible(/* on */){
      const panel = document.getElementById('svm-panel');
      if (panel) panel.style.display = '';    
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          updateMapPadding();
          try { google.maps.event.trigger(map, 'resize'); } catch(_) {}
        });
      });
    }




(async () => {
  try {
    const mod = await import('/static/js/hazard-report.js');
    const createGlowReporter = mod.createGlowReporter || mod.default;
    if (typeof createGlowReporter !== 'function') {
      console.error('hazard-report.js did not export createGlowReporter');
      return;
    }

    const reportBtn = document.querySelector('#svm-hz-report');
    if (!reportBtn) {
      console.warn('Report button #svm-hz-report not found in DOM');
      return;
    }

    const anonFp = localStorage.getItem('anonFp') || (crypto.randomUUID?.() || String(Math.random()));
    localStorage.setItem('anonFp', anonFp);

    const reporter = createGlowReporter({
      map,
      reportBtn,
      emojiUrl: '/static/images/ghost.png',
       onConfirm: async ({ lat, lng, ttlSecs, kind }) => {
        try {
            await postJSON('/api/hazards/', {
            lat, lng, ttl_secs: ttlSecs, kind,
            note_short: '', severity: 1, fp: anonFp
            });

            const rep = window.__glowReporter;
            if (rep) {
            rep.__placeHazardMarker({ lat, lng }, ttlSecs, kind);
          
            const keys = [...rep._hazards.keys()];
            const lastKey = keys[keys.length - 1];
            const entry = rep._hazards.get(lastKey);
            if (entry) entry.id = entry.id || `local:${Date.now()}`;
            }

            // pull from server too
            safeSync();
        } catch (e) {
            console.error('report submit failed', e);
            showToast?.('Could not save your report. Please try again.');
        }
        },
      setLayersVisible: ({ venues, lighting }) => {
        setVenuesVisible?.(!!venues);
        setLightingVisible?.(!!lighting);
      },
      getLayersVisible: () => ({ venues: state.venues, lighting: state.lighting })
    });

    window.__glowReporter = reporter;
    
    // pull immediately when user enters report mode
    const safeSync = () => syncActiveHazards().catch(err => console.warn('hazard sync', err));

    reportBtn.addEventListener('click', () => {
    // if map bounds aren’t ready yet, wait for the first idle then sync
    const b = map.getBounds?.();
    if (!b) {
        google.maps.event.addListenerOnce(map, 'idle', safeSync);
    } else {
        safeSync();
    }
    });
    safeSync();
    setInterval(safeSync, 15000);

  } catch (e) {
    console.error('Failed to load hazard-report.js', e);
  }
})();

function getCsrf() {
  const m = document.cookie.match(/csrftoken=([^;]+)/);
  return m ? m[1] : '';
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'X-CSRFToken': getCsrf(),     // remove if you used csrf_exempt
    },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('network');
  return res.json();
}

async function getJSON(url) {
  const res = await fetch(url, { credentials:'same-origin' });
  if (!res.ok) throw new Error('network');
  return res.json();
}

async function syncActiveHazards() {
  // wait until both map bounds and reporter exist
  const rep = window.__glowReporter;
  const b   = map.getBounds?.();
  if (!rep || !b) return;

  const sw = b.getSouthWest(), ne = b.getNorthEast();
  const qs = new URLSearchParams({
    sw_lat: sw.lat(), sw_lng: sw.lng(),
    ne_lat: ne.lat(), ne_lng: ne.lng(),
  }).toString();

  const { now, items } = await getJSON(`/api/hazards/active/?${qs}`);
  const serverNow = Date.parse(now) / 1000;

  // helper: does a server hazard already exist among local entries?
  const hasServerId = (id) => {
    for (const entry of rep._hazards?.values?.() || []) {
      if (entry?.id === id) return true;
    }
    return false;
  };

  for (const h of items) {
    const created = Date.parse(h.created_at) / 1000;
    const expires = Date.parse(h.expires_at) / 1000;
    const remain  = Math.max(0, Math.floor(expires - serverNow));
    if (remain <= 0) continue;

    // use our helper instead of Map.has(server_id)
    if (!hasServerId(h.public_id)) {
      // place marker
      rep.__placeHazardMarker({ lat: h.lat, lng: h.lng }, remain, h.kind);

      // tag the *most recently* inserted local entry with the server id
      const keys = [...rep._hazards.keys()];
      const lastKey = keys[keys.length - 1];
      const entry = rep._hazards.get(lastKey);
      if (entry) entry.id = h.public_id;
    }
  }
}







function setVenuesVisible(on) {
      state.venues = !!on;

      // show/hide venue markers
      venueMarkers.forEach(m =>
        (m.map !== undefined) ? (m.map = on ? map : null) : m.setMap(on ? map : null)
      );

      // show/hide clusterer
      if (on) {
        refreshCluster();          
      } else if (clusterer) {
        clusterer.clearMarkers?.();
        clusterer.setMap?.(null);
      }

      renderVenueList();
      updateMapPadding();
    }

    function setLightingVisible(on) {
      state.lighting = !!on;
      lightingLayer?.setVisible(on);
    }




  
 



    // Attach SQI
    const sqi = GlowSQI.attachSQI(map, { listenToButtons: ['btn-lighting','btn-venues'] });
    window.__glow_sqi_instance = sqi;

    // Overlay dock (right stack) + padding
    function ensureOverlayDock(){
      let dock = document.getElementById('gw-overlay-dock');
      if (!dock){
        dock = document.createElement('div');
        dock.id = 'gw-overlay-dock';
        dock.style.cssText = `
          position:absolute; right:14px; top:56px; z-index:10000;
          display:flex; flex-direction:column; align-items:flex-end; gap:10px;
          pointer-events:none;
        `;
        mapEl.appendChild(dock);
      }
      return dock;
    }
    const overlayDock = ensureOverlayDock();

  
  const scorePillEl = document.getElementById('gw-score-pill');
  const compareBox  = document.getElementById('wwi-compare');
  const compareInner= document.querySelector('#wwi-compare .wwi-compare-inner');


function ensurePillTextNode() {
  const pill = document.getElementById('gw-score-pill');
  if (!pill) return null;

  let span = pill.querySelector('.wwi-pill-text');
  if (!span) {
    span = document.createElement('span');
    span.className = 'wwi-pill-text';
    const caret = pill.querySelector('.wwi-pill-caret');
    if (caret) pill.insertBefore(span, caret);
    else pill.appendChild(span);
  }
  return span;
}


/** Toggle the bottom drawer (route comparison). */
function toggleCompare(open){
  const willOpen = (open==null) ? compareBox.hasAttribute('hidden') : !!open;
  if (willOpen){
    compareBox.removeAttribute('hidden');
    scorePillEl?.setAttribute('aria-expanded','true');
  }else{
    compareBox.setAttribute('hidden','');
    scorePillEl?.setAttribute('aria-expanded','false');
  }
}
scorePillEl?.addEventListener('click', ()=> toggleCompare());

/** Close helper (use this where you previously called hideScoreToast). */
function hideCompare(){ toggleCompare(false); }


    // View history
    const viewHistory = [];
    function snapshotView() {
      const c = map.getCenter();
      return c ? { center: { lat: c.lat(), lng: c.lng() }, zoom: map.getZoom() || 14 } : null;
    }
    function applyView(v) { if (v) { map.setCenter(v.center); map.setZoom(v.zoom); } }
    function pushView(v) {
      if (!v) return;
      viewHistory.push(v);
      if (viewHistory.length > 10) viewHistory.shift();
      showBack();                 // reveal when we have a view to go back to
    }
    function popView() {
      const v = viewHistory.pop();
      if (!viewHistory.length) hideBack();
      return v;
    }

    // Control UI (use Google Maps control stack so we don't block built-ins)
    const BACK_POS = google.maps.ControlPosition.TOP_CENTER; // away from Fullscreen (usually bottom-right)
    const backCtrl = document.createElement('div');
    backCtrl.style.cssText = 'margin:8px 0;';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.id = 'gw-prevview';
    backBtn.setAttribute('aria-label', 'Return to previous view (Esc)');
    backBtn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:.45rem">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Previous view
      </span>`;
    backBtn.style.cssText = `
      cursor:pointer; pointer-events:auto;
      padding:.45rem .7rem; border-radius:999px; font:700 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      background:#111827; color:#e5e7eb; border:1px solid rgba(255,255,255,.14);
      box-shadow:0 6px 16px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.08);
      transition:transform .12s ease, background .12s ease, box-shadow .12s ease, opacity .2s ease;
    `;
        // neutral look
    backBtn.style.background = 'rgba(17,24,39,.92)';     // #111827
    backBtn.style.border     = '1px solid rgba(255,255,255,.18)';
    backBtn.style.color      = '#E5E7EB';                // text
    backBtn.onmouseenter = () => backBtn.style.background = 'rgba(15,23,42,.98)';
    backBtn.onmouseleave = () => backBtn.style.background = 'rgba(17,24,39,.92)';
    // keyboard focus ring
    backBtn.onfocus = () => backBtn.style.boxShadow = '0 0 0 3px rgba(59,130,246,.35)';
    backBtn.onblur  = () => backBtn.style.boxShadow = '0 6px 16px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.08)';
    backBtn.onmousedown  = () => backBtn.style.transform = 'translateY(1px)';
    backBtn.onmouseup    = () => backBtn.style.transform = 'translateY(0)';
    backBtn.onclick = () => applyView(popView());

    backCtrl.appendChild(backBtn);
    map.controls[BACK_POS].push(backCtrl);

    // show/hide helpers + gentle auto-hide (returns if hovered)
    let hideTimer = null;
    function showBack() {
      backCtrl.style.display = '';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        // don't auto-hide while user is hovering
        const r = backBtn.getBoundingClientRect();
        const mx = window._gw_lastMouseX, my = window._gw_lastMouseY;
        if (mx != null && my != null && mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) return;
        if (!viewHistory.length) return;
        backCtrl.style.opacity = '0.65';
      }, 4000);
    }
    function hideBack() {
      clearTimeout(hideTimer);
      backCtrl.style.opacity = '1';
      backCtrl.style.display = 'none';
    }
    hideBack(); // start hidden

    // Track mouse position (for auto-hide logic)
    window.addEventListener('mousemove', (e) => { window._gw_lastMouseX = e.clientX; window._gw_lastMouseY = e.clientY; }, { passive:true });

    // Keyboard shortcut: Esc = previous view
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && viewHistory.length) { e.preventDefault(); applyView(popView()); }
    }, { passive:false });




    function isOverlayedPanel(panel, host) {
      if (!panel) return false;
      const css = getComputedStyle(panel);
      const overlayPos = css.position === 'absolute' || css.position === 'fixed';
      return overlayPos && host.contains(panel); // only treat as overlay if it's inside #map
    }


    function updateMapPadding(){
      const rightW = overlayDock.offsetWidth || 0;

      // only count left panel if it is overlayed inside the map
      const panel  = document.getElementById('svm-panel');
      const leftW  = (panel && isOverlayedPanel(panel, mapEl) && panel.offsetWidth) ? panel.offsetWidth : 0;

      map.setOptions({
        padding: { top: 12, right: rightW + 8, bottom: 12, left: leftW ? leftW + 8 : 0 }
      });
    }
    window.addEventListener('resize', updateMapPadding, { passive:true });
    ensureSidePanel();
    setVenuePanelVisible(state.venues);
    updateMapPadding();

    // ----- User marker -----
    let userMarker = null;
    let userAccCircle = null;
    let userRipple = null;      // animated ring
    let _youRippleRAF = null;   // RAF handle


    function buildYouDirContent(){
      const wrap = document.createElement('div');
      wrap.className = 'gw-you-dir';
      wrap.innerHTML = `
        <div class="gw-you-core"></div>
        <div class="gw-you-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3l5 10-5-2-5 2 5-10z" fill="#fff"/>
          </svg>
        </div>`;
      return wrap;
    }

    function highlightUserMarker(){
    if (!userMarker?.content) return;
    const el = userMarker.content;
    el.classList.remove('gw-you-burst');
    void el.offsetWidth;
    el.classList.add('gw-you-burst');
    setTimeout(()=> el.classList.remove('gw-you-burst'), 900);
  }
    
    
  function ensureSakuraYouCSS(){
  if (document.getElementById('gw-you-sakura')) return;
    const s = document.createElement('style');
    s.id = 'gw-you-sakura';
    s.textContent = `
      .gw-you-dir { position: relative; width: 32px; height: 32px; }

      /* core dot */
      .gw-you-core{
        position:absolute; inset:0; border-radius:50%;
        background:#f472b6;                
        border:2px solid #fff;
        box-shadow: 0 0 0 6px rgba(251,207,232,.55); /* soft pink glow */
      }

      /* ambient “hue” pulse around the core */
      .gw-you-ping{
        position:absolute; inset:-14px; border-radius:50%;
        background: radial-gradient(circle,
                    rgba(251,207,232,.75) 0%,
                    rgba(251,207,232,.30) 40%,
                    rgba(251,207,232,0) 70%);
        animation: youPulse 1.6s ease-out infinite;
        pointer-events:none;
      }

      /* small heading arrow stays white */
      .gw-you-arrow{
        position:absolute; left:50%; top:50%;
        transform: translate(-50%,-60%);
        width:22px; height:22px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.25));
        pointer-events:none;
      }
      .gw-you-arrow svg{ width:100%; height:100%; display:block; }

      /* little “burst” when we update position */
      .gw-you-burst .gw-you-core{ animation: youBurst .9s ease-out 1; }

      @keyframes youPulse {
        0%   { transform: scale(.65); opacity:.85; }
        70%  { transform: scale(1.25); opacity:.18; }
        100% { transform: scale(1.45); opacity:0; }
      }
      @keyframes youBurst {
        0%   { box-shadow: 0 0 0 0 rgba(244,114,182,.6); }
        100% { box-shadow: 0 0 0 16px rgba(244,114,182,0); }
      }
    `;
      document.head.appendChild(s);
    }

    function updateUserRipple(pos, accuracy){
    // stop if no accuracy
    if (!Number.isFinite(accuracy) || accuracy <= 10) {
      if (userRipple) { userRipple.setMap(null); userRipple = null; }
      if (_youRippleRAF) cancelAnimationFrame(_youRippleRAF), _youRippleRAF = null;
      return;
    }

    const R0 = Math.max(accuracy * 0.6, 15);   // start radius
    const R1 = Math.max(accuracy * 1.25, 25);  // end radius
    const D  = 1400;                           // ms

    if (!userRipple) {
      userRipple = new google.maps.Circle({
        map, center: pos, radius: R0,
        strokeColor: '#f472b6',   // sakura edge
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillOpacity: 0,           // ring only
        zIndex: 4
      });
    } else {
      userRipple.setCenter(pos);
    }

    // drive the animation
    const t0 = performance.now();
    const tick = (t) => {
      const p = ((t - t0) % D) / D;           // 0..1
      const r = R0 + (R1 - R0) * p;
      const op = 0.8 * (1 - p);               // fade out
      userRipple.setRadius(r);
      userRipple.setOptions({ strokeOpacity: op });
      _youRippleRAF = requestAnimationFrame(tick);
    };
    if (!_youRippleRAF) _youRippleRAF = requestAnimationFrame(tick);
  }

  ensureSakuraYouCSS();
   

  function putUserMarker(lat, lng, opts = {}){

    if (!SHOW_USER_LOCATION) return;
    const pos = { lat, lng };

    // accuracy disk — soft pink fill, no harsh outline
    if (!userAccCircle) {
      userAccCircle = new google.maps.Circle({
        map, center: pos, radius: 0,
        strokeOpacity: 0,                  // hide ring
        fillColor: '#fbcfe8',              
        fillOpacity: 0.25,
        zIndex: 2
      });
    } else {
      userAccCircle.setCenter(pos);
    }
    if (Number.isFinite(opts.accuracy)) userAccCircle.setRadius(Math.max(0, opts.accuracy));
    userAccCircle.setVisible(Number.isFinite(opts.accuracy) && opts.accuracy > 10);

    // animated ripple (map-space)
    updateUserRipple(pos, opts.accuracy);

    // marker (DOM, bright sakura)
    if (google.maps.marker?.AdvancedMarkerElement) {
      if (!userMarker) {
        userMarker = new google.maps.marker.AdvancedMarkerElement({
          map, position: pos, content: buildYouDirContent(),
          title: 'Your location', zIndex: google.maps.Marker.MAX_ZINDEX + 100
        });
      } else {
        userMarker.position = pos;
      }
      const arrow = userMarker.content?.querySelector('.gw-you-arrow');
      if (arrow && Number.isFinite(opts.heading)) {
        arrow.style.transform = `translate(-50%,-60%) rotate(${opts.heading}deg)`;
      }
    } else {
      // fallback: classic circle, sakura palette
      if (!userMarker) {
        userMarker = new google.maps.Marker({
          map, position: pos, title: 'Your location',
          zIndex: google.maps.Marker.MAX_ZINDEX + 100,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
                  fillColor: '#f472b6', fillOpacity: 1,
                  strokeColor: '#ffffff', strokeWeight: 3 }
        });
      } else {
        userMarker.setPosition(pos);
      }
    }

    highlightUserMarker();
  }

   function setUserMarkerVisible(on){

      if (!SHOW_USER_LOCATION) return;
      if (userMarker) (userMarker.map!==undefined) ? (userMarker.map = on ? map : null) : userMarker.setMap(on ? map : null);
      if (userAccCircle) userAccCircle.setMap(on ? map : null);
      if (userRipple) userRipple.setMap(on ? map : null);
      if (!on && _youRippleRAF) { cancelAnimationFrame(_youRippleRAF); _youRippleRAF = null; }
    }


    // ----- Loader for lighting fetch -----
    const gifUrl  = mapEl.dataset.loadingGif || "/static/images/data-loading.gif";
    const gifSize = parseInt(mapEl.dataset.loadingSize || "96", 10);
    mapEl.style.position = "relative";
    const loader = document.createElement("div");
    loader.style.cssText = [
      "position:absolute","inset:0","display:none","place-items:center",
      "z-index:4","background:rgba(0,0,0,.35)","pointer-events:none"
    ].join(";");
    loader.innerHTML = `
      <div style="display:flex;align-items:center;gap:.9rem;background:rgba(0,0,0,.7);color:#fff;padding:1rem 1.2rem;border-radius:.9rem;box-shadow:0 8px 24px rgba(0,0,0,.25);font:600 15px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
        <img src="${gifUrl}" style="width:${gifSize}px;height:${gifSize}px;object-fit:contain" />
        <span>Please wait while the street lighting data is loading…</span>
      </div>`;
    mapEl.appendChild(loader);
    const showLoader=()=>{ loader.style.display="grid"; };
    const hideLoader=()=>{ loader.style.display="none"; };

    // ----- Toggles -----
    const btnLighting = document.getElementById('btn-lighting');
    const btnVenues   = document.getElementById('btn-venues');
    const setBtnState = (btn,on)=>{ if(!btn) return; btn.classList.toggle('on',on); btn.setAttribute('aria-pressed', on?'true':'false'); };
    function syncButtonsFromState() { setBtnState(btnLighting, state.lighting); setBtnState(btnVenues, state.venues); }
    [btnLighting, btnVenues].forEach(b=>{ b?.classList.add('svm-toggle','on'); b?.setAttribute('aria-pressed','true'); });
    syncButtonsFromState();

    // ----- Route bar UI (replaces any old .svm-search) -----
    (function injectUIStyles(){
      if (document.getElementById('gw-routebar-css')) return;
      const s = document.createElement('style'); s.id='gw-routebar-css';
      s.textContent = `
        .gw-routebar{ display:flex; align-items:center; gap:.5rem; min-width:280px; max-width:48rem; flex:1 1 28rem;
          background:rgba(15,23,42,.7); backdrop-filter:blur(8px); padding:.35rem; border-radius:12px; border:1px solid rgba(255,255,255,.08); }
        .gw-field{ position:relative; flex:1; }
        .gw-field input{ width:100%; height:38px; border:0; outline:0; padding:.45rem .9rem .45rem 2.1rem; background:#0b1220; color:#fff; border-radius:10px; font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; border:1px solid rgba(255,255,255,.08); }
        .gw-field input:focus{ box-shadow:0 0 0 3px rgba(59,130,246,.35); }
        .gw-ico{ position:absolute; left:.6rem; top:50%; transform:translateY(-50%); opacity:.7; font-size:16px; }
        .gw-swap{ width:38px; height:38px; display:grid; place-items:center; border:1px solid rgba(255,255,255,.12); background:#111827; color:#fff; border-radius:10px; cursor:pointer; }
        .gw-swap:hover{ background:#0f172a; }
        .gw-routebar .gw-btn{ height:38px; border-radius:10px; font-weight:700; }
        .gw-routebar .gw-btn-primary{ background:#3b82f6; color:#fff; border:0; padding:0 .9rem; }
        .gw-routebar .gw-btn-ghost{ background:#1f2937; color:#fff; border:0; padding:0 .8rem; }
        @media (max-width: 640px){ .gw-routebar{ flex-wrap:wrap; } .gw-routebar .gw-btn-primary, .gw-routebar .gw-btn-ghost{ flex:0 0 auto; } }
        ${!USE_ROUTE_SCORE ? '#gw-score-pill, #gw-score-toast{display:none!important}' : ''}
        #btn-lighting.svm-toggle, #btn-venues.svm-toggle{ background:#1b2233; color:#cbd5e1; border:1px solid rgba(255,255,255,.06); transition:background .15s ease, box-shadow .15s ease, color .15s ease; }
        #btn-lighting.svm-toggle.on, #btn-venues.svm-toggle.on{ background:linear-gradient(180deg,#ffe08a,#ffd166 70%); color:#111; box-shadow:inset 0 1px 0 rgba(255,255,255,.45), 0 6px 18px rgba(255,209,102,.35); }
        #btn-lighting.svm-toggle:not(.on):hover, #btn-venues.svm-toggle:not(.on):hover{ background:#222b3b; }
      `;
      document.head.appendChild(s);
    })();

    const searchWrap = document.querySelector('.svm-search');
    const routeBar = document.createElement('div');
    routeBar.className = 'gw-routebar';
    routeBar.innerHTML = `
      <div class="gw-field">
        <i class="bi bi-geo-alt gw-ico" aria-hidden="true"></i>
        <input id="gw-origin" placeholder="From" aria-label="Origin" />
      </div>
      <button id="gw-swap" class="gw-swap" title="Swap"><i class="bi bi-arrow-left-right"></i></button>
      <div class="gw-field">
        <i class="bi bi-flag gw-ico" aria-hidden="true"></i>
        <input id="gw-dest" placeholder="To" aria-label="Destination" />
      </div>
      <button id="gw-route" class="gw-btn gw-btn-primary">Go</button>
      <button id="gw-clear" class="gw-btn gw-btn-ghost">Clear</button>
    `;
    if (searchWrap) searchWrap.replaceWith(routeBar);

    
    // --- Route preference UI state ('safer' | 'shorter' | 'auto') ---
    let ROUTE_PREF = 'auto';

    const prefBtns = Array.from(document.querySelectorAll('.wwi-prefbtn'));

    // Reflect ROUTE_PREF on the UI via aria-selected
    function applyPrefUI() {
      prefBtns.forEach((btn) => {
        btn.setAttribute('aria-selected', String(btn.dataset.pref === ROUTE_PREF));
      });
    }

    // Click handlers for the three buttons
    prefBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        ROUTE_PREF = btn.dataset.pref;
        applyPrefUI();

        // Optional: keep your Google routing bias flag in sync
        // (guard with typeof to avoid ReferenceError if the flag isn't defined yet)
        if (typeof PREFER_SAFER_ROUTING !== 'undefined') {
          PREFER_SAFER_ROUTING = (ROUTE_PREF === 'safer');
        }

        // === ADD: show intro when switching to Auto ===
        if (ROUTE_PREF === 'auto') {
          showAutoModeIntro();
        }
      });
    });
    
    // Initial paint for the segmented control
    applyPrefUI();
    
  
    // ----- City boundary -----
    const BOUNDARY_URL = '/static/data/city-of-melbourne-boundary.geojson';
    let CITY_BOUNDS = new google.maps.LatLngBounds(
      { lat: -37.8750, lng: 144.9000 },
      { lat: -37.7700, lng: 145.0550 }
    );

    let MAX_VENUES = 70;
    let cityPolyForTest = null;
    function isInsideCity(latLng){
      if (cityPolyForTest && google.maps.geometry?.poly?.containsLocation) {
        return google.maps.geometry.poly.containsLocation(latLng, cityPolyForTest);
      }
      return CITY_BOUNDS.contains(latLng);
    }
    async function loadCityBoundary() {
      try {
        // was: const res = await fetch(BOUNDARY_URL, { headers: { Accept: 'application/json' } });
        const res = await fetchWithCache(BOUNDARY_URL, {
          key: `gw:boundary:${BOUNDARY_URL}`,
          ttlMs: 12 * 60 * 60 * 1000
        });
        if (!res.ok) throw 0;
        const gj = await res.json();
        let ring = null;
        const feat = (gj.features?.[0]) || gj;
        const geom = feat.geometry?.type ? feat.geometry : feat;
        if (geom.type === 'Polygon') ring = geom.coordinates[0];
        else if (geom.type === 'MultiPolygon') ring = geom.coordinates.map(p => p[0]).sort((a,b)=>b.length-a.length)[0];
        if (!ring) throw 0;
        const cityPath = ring.map(([lng, lat]) => ({ lat, lng }));
        CITY_BOUNDS = new google.maps.LatLngBounds();
        cityPath.forEach(p => CITY_BOUNDS.extend(p));
        const world = [{lat:85,lng:-180},{lat:85,lng:180},{lat:-85,lng:180},{lat:-85,lng:-180}];
        new google.maps.Polygon({ paths:[world, cityPath], map, strokeOpacity:0, fillColor:'#0b1120', fillOpacity:0.35, clickable:false, zIndex:2 });
        new google.maps.Polygon({ paths:cityPath, map, strokeColor:'#8b9cff', strokeOpacity:0.9, strokeWeight:2, fillOpacity:0, clickable:false, zIndex:8 });
        cityPolyForTest = new google.maps.Polygon({ paths: cityPath });
        map.setOptions({ restriction: { latLngBounds: CITY_BOUNDS, strictBounds: false } });
        if (!window.__userHasStart) { map.setCenter(MELBOURNE_CENTRAL); map.setZoom(16); }
      } catch {
        map.setOptions({ restriction:{ latLngBounds: CITY_BOUNDS, strictBounds: false } });
        if (!window.__userHasStart) { map.setCenter(MELBOURNE_CENTRAL); map.setZoom(16); }
      }
    }
    loadCityBoundary();

    // ----- Lighting layer -----
    let lightingLayer = null, lightingLoaded = false;
    const clamp = (n, lo, hi)=>Math.max(lo, Math.min(hi, n));


    async function addLightingLayers(url){
      showLoader();
      window.__lightingSegments = [];
      if (window.__glowRAF) cancelAnimationFrame(window.__glowRAF);
      let gj = { type:'FeatureCollection', features:[] };

      try {
        // const res = await fetch(url,{ headers:{Accept:'application/json'} });
        const res = await fetchWithCache(url, {
          key: `gw:lighting:${url}`,
          ttlMs: 12 * 60 * 60 * 1000
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) gj = data;
          else if (Array.isArray(data?.features)) gj = { type:'FeatureCollection', features:data.features };
        }
      } catch(e){
        console.error('Lighting fetch error:', e);
      }
      finally { hideLoader(); }

      const feats = Array.isArray(gj.features) ? gj.features : [];
      const lineFeats = feats.filter(f=>/LineString/.test(f.geometry?.type||""));
      const lampFeats = feats.filter(f=>f.geometry?.type==='Point');
      const sets=[], flows=[];

      function buildSet(path){
        const halo=new google.maps.Polyline({ path, map:null, zIndex:3, clickable:false, strokeColor:'#ff9d2d', strokeOpacity:0.18, strokeWeight:12 });
        const top =new google.maps.Polyline({ path, map:null, zIndex:4, clickable:false, strokeColor:'#ffd166', strokeOpacity:0.95, strokeWeight:4 });
        const lineSymbol={ path:'M 0,-1 0,1', strokeOpacity:1, strokeColor:'#ffd166', scale:2 };
        const flow=new google.maps.Polyline({ path, map:null, zIndex:5, clickable:false, strokeOpacity:0, icons:[{ icon:lineSymbol, offset:'0', repeat:'16px' }] });
        sets.push({halo,top,flow}); flows.push(flow);
        // SQI: expose the 'top' lit segments for distance checks
        window.__lightingSegments.push(top);
      }
      lineFeats.forEach(f=>{
        const g=f.geometry;
        const parts=(g.type==='LineString') ? [g.coordinates] : (g.coordinates||[]);
        parts.forEach(part=> buildSet(part.map(([lng,lat])=>({lat,lng}))));
      });

      const dots=new google.maps.Data({ map:null });
      if (lampFeats.length){
        try{ dots.addGeoJson({ type:'FeatureCollection', features:lampFeats }); }catch(e){}
      }
      dots.setStyle(()=>({
        clickable:false,
        icon:{ path:google.maps.SymbolPath.CIRCLE, scale:3.6, fillColor:'#ffd166', fillOpacity:0.95, strokeColor:'#3b2a00', strokeWeight:1 },
        zIndex:6
      }));

      function applyStyle(){
        const z = map.getZoom() ?? 14;
        const showLines = z>=13, showLamps=z>=17;
        const hw=clamp((z-10)*2.0,6,16), tw=clamp((z-10)*0.9,2,6);
        sets.forEach(({halo,top,flow})=>{
          halo.setOptions({strokeWeight:hw,map:showLines?map:null});
          top.setOptions ({strokeWeight:tw,map:showLines?map:null});
          flow.setMap(showLines?map:null);
        });
        dots.setMap(showLamps?map:null);
      }
      applyStyle();
      const zoomL = map.addListener('zoom_changed', applyStyle);

      const speedPxPerSec=60; let t0=null;
      function loop(t){
        if(!t0) t0=t;
        const dt=(t-t0)/1000, offset=`${(dt*speedPxPerSec)%200}px`;
        flows.forEach(pl=>{ const icons=pl.get('icons'); if(icons&&icons[0]){ icons[0].offset=offset; pl.set('icons',icons); }});
        window.__glowRAF=requestAnimationFrame(loop);
      }
      window.__glowRAF=requestAnimationFrame(loop);

      const hasData = (sets.length>0) || (lampFeats.length>0);
      return {
        setVisible(on){
          const m=on?map:null;
          sets.forEach(({halo,top,flow})=>{ halo.setMap(m); top.setMap(m); flow.setMap(m); });
          dots.setMap(on?(map.getZoom()>=17?map:null):null);
        },
        remove(){ google.maps.event.removeListener(zoomL); if(window.__glowRAF){ cancelAnimationFrame(window.__glowRAF); window.__glowRAF=null; } sets.forEach(({halo,top,flow})=>{ halo.setMap(null); top.setMap(null); flow.setMap(null); }); dots.setMap(null); },
        hasData
      };
    }
    function lightingApiUrlsForMap() {
      return ['data/lighting.geojson', '/data/lighting.geojson'];
    }

    
    
    async function ensureCityLighting(){

      if (!lightingLoaded) {
        const candidates = lightingApiUrlsForMap();
        for (const url of candidates) {
          const layer = await addLightingLayers(url);
          if (layer?.hasData) { lightingLayer = layer; lightingLoaded = true; break; }
        }
      }
      lightingLayer?.setVisible(state.lighting);
      if (window.__glow_sqi_instance) window.__glow_sqi_instance.updateCenter();
    }

    

    const VENUE_STYLES = {
        bank:  { bg:'#3B82F6', emoji:'🏦', label:'Bank' },            
        cafe:  { bg:'#B45309', emoji:'☕',  label:'Cafe' },            
        convenience_store:{ bg:'#84CC16', emoji:'🏪', label:'Convenience' },    
        clinics: { bg:'#0EA5A2', emoji:'🏥', label:'Clinic' },          
        doctors: { bg:'#22C55E', emoji:'👩‍⚕️', label:'Doctor' },        
        department_store: { bg:'#6366F1', emoji:'🛍️', label:'Dept. store' },     
        fast_food: { bg:'#F97316', emoji:'🍔', label:'Fast food' },      
        police: { bg:'#2563EB', emoji:'👮🏻‍♂️', label:'Police' },        
        post_office:{ bg:'#EF4444', emoji:'📮', label:'Post office' },     
        restaurant:{ bg:'#EAB308', emoji:'🍽️', label:'Restaurant' },    
        mall: { bg:'#A855F7', emoji:'🏬', label:'Mall' },           
        supermarket:{ bg:'#03fc7b', emoji:'🛒', label:'Supermarket' },
        pharmacy:{ bg:'#b0f542', emoji:'👩🏻‍🔬', label:'Pharmacy' }     
      };
    let selectedVenueMarker = null;

    function applySelectedStyle(marker){

      marker.__origZ = marker.__origZ ?? marker.zIndex;
      marker.zIndex = google.maps.Marker.MAX_ZINDEX + 20;

      // AdvancedMarkerElement: toggle a class on the DOM node
      if (google.maps.marker?.AdvancedMarkerElement &&
          marker instanceof google.maps.marker.AdvancedMarkerElement) {
        marker.content?.classList.add('gw-selected');
        return;
      }

      // Classic Marker: enlarge icon and keep original for rollback
      if (marker.setIcon) {
        const base = marker.getIcon && marker.getIcon() || {};
        marker.__baseIcon = marker.__baseIcon || base;
        const bigger = {
          ...base,
          scale: (base.scale || 6) * 1.6,
          strokeWeight: (base.strokeWeight || 1.5) + 1,
        };
        marker.setIcon(bigger);
      }
    }

    function clearSelectedStyle(marker){
      if (!marker) return;
      if (google.maps.marker?.AdvancedMarkerElement &&
          marker instanceof google.maps.marker.AdvancedMarkerElement) {
        marker.content?.classList.remove('gw-selected');
      } else if (marker.setIcon && marker.__baseIcon) {
        marker.setIcon(marker.__baseIcon);
      }
      if (marker.__origZ != null) marker.zIndex = marker.__origZ;
    }

    function selectVenueMarker(marker){
      if (selectedVenueMarker === marker) return;
      if (selectedVenueMarker) clearSelectedStyle(selectedVenueMarker);
      selectedVenueMarker = marker;
      applySelectedStyle(marker);
    }

    function deselectVenueMarker(){
      if (!selectedVenueMarker) return;
      clearSelectedStyle(selectedVenueMarker);
      selectedVenueMarker = null;
    }

    function pickFgFor(bgHex){
      // accepts "#rrggbb"
      const h = (bgHex||'#000').replace('#','');
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      // perceived luminance
      const L = (0.2126*r + 0.7152*g + 0.0722*b) / 255;
      return L > 0.55 ? '#111' : '#fff';
    }


    function createVenueBadge(type){
      const st = VENUE_STYLES[type] || { bg:'#4ade80', emoji:'📍' };
      const fg = pickFgFor(st.bg);
      const el = document.createElement('div');
      el.className = 'gw-venue';
      el.style.cssText = `
        width:28px;height:28px;border-radius:12px;display:grid;place-items:center;
        background:${st.bg}; color:${fg};
        font-size:16px; line-height:1; user-select:none;
        border:2px solid #fff; box-shadow:0 1px 0 rgba(0,0,0,.45),0 0 0 3px ${st.bg}40;
      `;
      el.textContent = st.emoji;
      return el;
    }


    function isTwentyFourSeven(details){

      const oh=details?.current_opening_hours||details?.opening_hours; if(!oh) return false;
      if (oh.weekday_text && oh.weekday_text.some(t=>/24\s*hours/i.test(t))) return true;
      if (oh.periods && oh.periods.length){ return oh.periods.some(p=>{ const o=p.open?.time, c=p.close?.time; if(!p.close) return true; return o==='0000' && c==='0000'; }); }
      return false;
    }

    const defaultOpenNowBadge = () => ({ is24:false, label:'Open now', cls:'svm-chip svm-chip--amber' });
   
    // Our API already tells us if it's 24/7 and today's hours. Fallbacks stay friendly.
    function hoursBadgeForApi(venue) {

      if (!venue) return defaultOpenNowBadge();

      // Server flag: strict 24/7 across the week
      if (venue.is_247 === true) {
        return { is24: true, label: '24/7', cls: 'svm-chip svm-chip--green' };
      }

      // Server flag: open right now for today's hours (True/False/Null)
      if (venue.open_now === true) {
        return { is24: false, label: 'Open now', cls: 'svm-chip svm-chip--amber' };
      }
      if (venue.open_now === false) {
        const txt = (venue.hours_today || '').trim();
        const label = txt ? txt : 'Closed';
        return { is24: false, label, cls: 'svm-chip svm-chip--gray' };
      }

      // Unknown: show today's hours or "Hours unknown"
      const label = venue.hours_today ? venue.hours_today : 'Hours unknown';
      const looksOpenish = /open|am|pm|\d/.test(label.toLowerCase());
      return { is24:false, label, cls: looksOpenish ? 'svm-chip svm-chip--amber' : 'svm-chip svm-chip--gray' };
    }

    (function ensureIwLinkColor(){
        const id = 'gw-iw-link-color';
        if (document.getElementById(id)) return;
        const s = document.createElement('style');
        s.id = id;
        s.textContent = `
        .gm-style .gm-style-iw a,
        .gm-style .gm-style-iw-c a {
          color: #2563eb !important;       /* brand blue */
          font-weight: 600;
          text-decoration: underline;
        }
        .gm-style .gm-style-iw a:visited,
        .gm-style .gm-style-iw-c a:visited {
          color: #1d4ed8 !important;
        }
        .gm-style .gm-style-iw a:hover,
        .gm-style .gm-style-iw-c a:hover {
          text-decoration: underline;
        }
      `;

        document.head.appendChild(s);
      })();


    let venueIW = null; 

    function openVenueInfoApi(venue, anchor){
  const name = venue?.name || 'Venue';
  const addr = venue?.address || '';
  const searchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((name+' '+addr).trim())}`;
  const badge = hoursBadgeForApi(venue);

  // ensure our link color CSS exists
  (function injectIwCss(){
    if (document.getElementById('gw-iw-css')) return;
    const s = document.createElement('style'); s.id = 'gw-iw-css';
    s.textContent = `.gm-style .svm-map-link{color:#4f46e5!important;font-weight:700;text-decoration:underline;}
                     .gm-style .svm-map-link:hover{opacity:.9;}`;
    document.head.appendChild(s);
  })();

  // create once, reuse forever
  if (!venueIW) {
    venueIW = new google.maps.InfoWindow({ maxWidth: 320 });
    venueIW.addListener('closeclick', () => {
      setUserMarkerVisible(true);
      deselectVenueMarker();
    });
  }

  // update content + open on the clicked marker
  venueIW.setContent(`
    <div style="min-width:240px">
      <div style="font-weight:600">${name}</div>
      <div class="small" style="opacity:.8">${addr}</div>
      <div class="small" style="margin:.35rem 0 .5rem 0;"><span class="${badge.cls}">${badge.label}</span></div>
      <div class="mt-2">
        <a class="svm-map-link" target="_blank" rel="noopener" href="${searchUrl}">
          View on Google Maps
        </a>
      </div>
    </div>
  `);

  setUserMarkerVisible(false);
  venueIW.open({ map, anchor });
}




    
    let venueMarkers=[], venueIndex=new Map();

    function fmtMeters(m){ if (!isFinite(m)) return ''; return (m < 950) ? `${Math.round(m/10)*10} m` : `${(m/1000).toFixed(1)} km`; }
    function distFromRef(pos){
      const ref = originLatLng || map.getCenter();
      if (!ref || !pos) return Infinity;
      try{
        const a = (ref.lat ? new google.maps.LatLng(ref.lat(), ref.lng()) : ref);
        const b = (pos.lat ? pos : new google.maps.LatLng(pos.lat, pos.lng));
        return google.maps.geometry.spherical.computeDistanceBetween(a,b);
      }catch{ return Infinity; }
    }

    function categorizeVenue(venue){

        // 1) Trust the API if it already gives one of your canonical types
        const tRaw = (venue?.type || '').toLowerCase().trim();
        const canonical = [
          'bank','cafe','convenience_store','clinics','doctors',
          'department_store','fast_food','police','post_office',
          'restaurant','mall','supermarket'
        ];
        if (canonical.includes(tRaw)) return tRaw;

        // 2) Fallback: infer from name/address keywords
        const n = (venue?.name || '').toLowerCase();
        const a = (venue?.address || '').toLowerCase();
        const hay = `${tRaw} ${n} ${a}`;

      if (/\b(bank|atm)\b/.test(hay))                              return 'bank';
      if (/\b(cafe|coffee|espresso|roastery)\b/.test(hay))         return 'cafe';
      if (/(convenience|7-?eleven|7 eleven|24.?hour.*store)/.test(hay)) return 'convenience_store';
      if (/\b(clinic|medical centre|walk-in|gp clinic)\b/.test(hay))     return 'clinics';
      if (/\b(doctor|gp|general practitioner|medical practice)\b/.test(hay)) return 'doctors';
      if (/\b(department store|myer|david jones)\b/.test(hay))     return 'department_store';
      if (/(fast[- ]?food|takeaway|kfc|burger king|hungry jack'?s|mcdonald'?s|subway|taco bell)/.test(hay)) return 'fast_food';
      if (/\b(police|police station)\b/.test(hay))                 return 'police';
      if (/\b(post office|auspost|postal)\b/.test(hay))            return 'post_office';
      if (/\b(restaurant|bistro|eatery|trattoria|izakaya)\b/.test(hay))  return 'restaurant';
      if (/\b(mall|shopping centre|shopping center)\b/.test(hay))  return 'mall';
      if (/\b(supermarket|grocery|coles|woolworths|aldi|iga)\b/.test(hay)) return 'supermarket';

      return null; // falls back to default badge/colors in createVenueBadge()
      }


    function renderVenueList(){
      
      if (!panelListEl) ensureSidePanel();

      if (!state.venues) {
      if (panelCountEl) panelCountEl.textContent = 0;
      if (panelListEl)  panelListEl.innerHTML =
        '<div class="small opacity-75 p-2">Safe venues are hidden. Turn on “Safe venues” to show them.</div>';
      if (showMoreEl) showMoreEl.style.display = 'none';
      updateMapPadding();
      return;
    }


      const items = [...venueIndex.values()];
     
      const mode = VENUE_FILTERS.show;

      const filtered = items.filter(it=>{
        const v = it.venue || {};
        let matchOpen = true;
        if (mode === '247') {
          matchOpen = v.is_247 === true;
        } else if (mode === 'open') {
          if (v.open_now === true)       matchOpen = true;
          else if (v.open_now === false) matchOpen = false;
          else {
            const t = (v.hours_today || '').toLowerCase();
            matchOpen = /open|am|pm|\d/.test(t);
          }
        }
        return matchOpen;
      });

      filtered.sort((a,b)=>{
        if (VENUE_FILTERS.sort === 'name') {
          return String(a.venue?.name||'').localeCompare(String(b.venue?.name||''));
        }
        const da = distFromRef(a.marker.getPosition?.()||a.marker.position);
        const db = distFromRef(b.marker.getPosition?.()||b.marker.position);
        return da - db;
      });

      const total   = Math.min(filtered.length, MAX_VENUES);
      const visible = Math.min(total, VISIBLE_LIMIT);

      if (panelCountEl) panelCountEl.textContent = total;
      if (!panelListEl) return;

      if (!visible) {
        panelListEl.innerHTML = `
          <div role="status" aria-live="polite"
              style="display:flex;align-items:flex-start;gap:.6rem;padding:.6rem .75rem;
                      background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.35);
                      border-radius:10px;color:#eab308;font:500 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
            <i class="bi bi-exclamation-triangle-fill" aria-hidden="true" style="font-size:1.1rem;line-height:1;"></i>
            <div style="color:#f5e6a7">
               No matching venues right now. Try changing your search or filter options.
            </div>
          </div>`;
        if (showMoreEl) showMoreEl.style.display = 'none';
        updateMapPadding();
        return;
      }


      panelListEl.innerHTML = filtered.slice(0, visible).map(({venue,type})=>{
        const st  = VENUE_STYLES[type] || { bg:'#4ade80', emoji:'📍' };
        const fg  = pickFgFor(st.bg);
        const pos = venue ? new google.maps.LatLng(venue.lat, venue.lng) : null;
        const d   = pos ? fmtMeters(distFromRef(pos)) : '';
        const badge = hoursBadgeForApi(venue);
        const open  = badge.label || 'Open now';
        const stCls = badge.is24 || /open/i.test(open) ? 'svm-status svm-status--open' : 'svm-status svm-status--closed';

        return `
          <div class="svm-item" data-id="${venue.id}">
            <div class="svm-brand"
                style="background:${st.bg};color:${fg};border:2px solid #fff;box-shadow:0 1px 0 rgba(0,0,0,.3);">
              ${st.emoji}
            </div>
            <div>
              <div class="svm-name">${venue.name || ''}</div>
              <div class="svm-dist">${d}${venue.address ? ` · ${venue.address}` : ''}</div>
              <div class="${stCls}">${open}</div>
            </div>
            <i class="bi bi-chevron-right opacity-75"></i>
          </div>`;
      }).join('');

      // row handlers
      panelListEl.querySelectorAll('.svm-item').forEach(row=>{
        const id = row.dataset.id;
        row.addEventListener('mouseenter',()=>{ const it=venueIndex.get(id); if(it) it.marker.zIndex=google.maps.Marker.MAX_ZINDEX+1; });
        row.addEventListener('mouseleave',()=>{ const it=venueIndex.get(id); if(it) it.marker.zIndex=undefined; });
        row.addEventListener('click',()=>{ const it=venueIndex.get(id); if(!it) return;
          const pos = it.marker.position || it.marker.getPosition(); if(!pos) return;
          selectVenueMarker(it.marker);  
          map.panTo(pos); openVenueInfoApi(it.venue, it.marker);
        });
      });

      if (showMoreEl) showMoreEl.style.display = (visible < total) ? '' : 'none';
      updateMapPadding();
    }


       

     
        
    let clusterer = null;
     
        
       

    function clearVenues(){

      deselectVenueMarker();   
      venueIW?.close();   
      venueMarkers.forEach(m => (m.map!==undefined) ? (m.map=null) : m.setMap(null));
      venueMarkers = [];
      venueIndex.clear();

      //clear clusters too
      if (clusterer) {
        clusterer.clearMarkers?.();
        clusterer.setMap?.(null);
        clusterer = null;
      }

      VISIBLE_LIMIT = FIRST_PAGE;   // reset page size
      renderVenueList();
  }


  // --- colored pulse for AdvancedMarkerElement badges ---
  (function ensureFlashCss(){
    if (document.getElementById('gw-flash-css')) return;
    const s = document.createElement('style');
    s.id = 'gw-flash-css';
    s.textContent = `
      @keyframes gwPulseCol {
        0%   { box-shadow: 0 0 0 0 rgba(var(--gw,99,102,241), .55); transform: scale(1); }
        50%  { box-shadow: 0 0 0 8px rgba(var(--gw,99,102,241), .30); transform: scale(1.15); }
        100% { box-shadow: 0 0 0 0 rgba(var(--gw,99,102,241), .00); transform: scale(1); }
      }
      .gw-pulse { animation: gwPulseCol 900ms ease-in-out 2; }
    `;
    document.head.appendChild(s);
  })();

  (function ensureVenueSelectedCss(){
        if (document.getElementById('gw-venue-selected-css')) return;
        const s = document.createElement('style');
        s.id = 'gw-venue-selected-css';
        s.textContent = `
          .gw-venue { transition: transform .15s ease, box-shadow .15s ease; }
          .gw-venue.gw-selected {
            transform: scale(1.18);
            box-shadow: 0 0 0 6px rgba(79,70,229,.22), 0 2px 8px rgba(0,0,0,.25);
          }
        `;
        document.head.appendChild(s);
  })();


  function flashVenueMarkers(markers, ms = 1600) {
    const toRGB = (hexOrRgb) => {
      // accept '#rrggbb' or 'rgb(r,g,b)'
      if (!hexOrRgb) return '99,102,241';
      if (/^rgb/i.test(hexOrRgb)) {
        const m = hexOrRgb.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/);
        return m ? `${m[1]},${m[2]},${m[3]}` : '99,102,241';
      }
      const h = hexOrRgb.replace('#','');
      if (h.length === 3) {
        const r = parseInt(h[0]+h[0],16), g = parseInt(h[1]+h[1],16), b = parseInt(h[2]+h[2],16);
        return `${r},${g},${b}`;
      }
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      return `${r},${g},${b}`;
    };

    const isShown = (m) => {
      try { return (m.getMap?.() ?? m.map) ? true : false; } catch { return true; }
    };
    const visible = markers.filter(isShown);
    if (!visible.length) return;

    visible.forEach(m => {
      m.__origZ = m.zIndex;
      m.zIndex = google.maps.Marker.MAX_ZINDEX + 10;

      // AdvancedMarkerElement: pulse the DOM node with the category color
      if (google.maps.marker?.AdvancedMarkerElement &&
          m instanceof google.maps.marker.AdvancedMarkerElement) {
        const el = m.content;
        if (el) {
          const bg = m.__color || getComputedStyle(el).backgroundColor;
          el.style.setProperty('--gw', toRGB(bg));
          el.classList.add('gw-pulse');
          setTimeout(() => el.classList.remove('gw-pulse'), ms + 100);
        }
      } else if (m.setIcon) {
        // Classic Marker: enlarge and tint outline with the category color
        const icon = m.getIcon && m.getIcon();
        const wasCircle = icon && icon.path === google.maps.SymbolPath.CIRCLE;
        if (wasCircle) {
          const cat = m.__color || '#4ade80';
          const bigger = { ...icon, scale: (icon.scale || 6) * 1.7, strokeColor: cat, strokeWeight: 3 };
          m.setIcon(bigger);
          setTimeout(() => m.setIcon(icon), ms);
        } else {
          m.setAnimation?.(google.maps.Animation.BOUNCE);
          setTimeout(() => m.setAnimation?.(null), Math.min(ms, 1400));
        }
      }
    });

    setTimeout(() => {
      visible.forEach(m => { m.zIndex = m.__origZ; delete m.__origZ; });
    }, ms + 120);
  }
  const defaultMapId = mapId || null;
  const darkMapId = mapEl?.dataset.darkMapId || 'c02e981ae7bd49671cb1d7ac';

  function setNightMode(on) {
    map.setOptions(on ? { mapId: darkMapId } : (defaultMapId ? { mapId: defaultMapId } : {}));
  }




  async function refreshCluster() {
    await ensureClustererLib();

    // Resolve constructor across UMD variants
    const Ctor =
      window.markerClusterer?.MarkerClusterer ??
      window.markerClusterer?.default ??
      (typeof window.MarkerClusterer === 'function'
        ? window.MarkerClusterer
        : window.MarkerClusterer?.MarkerClusterer);

    if (!Ctor) {
      console.error('MarkerClusterer constructor not found.');
      return;
    }

    const SuperClusterAlgo =
      window.markerClusterer?.SuperClusterAlgorithm ??
      window.MarkerClusterer?.SuperClusterAlgorithm ??
      null;

    // Clear previous instance
    if (clusterer) {
      clusterer.clearMarkers?.();
      clusterer.setMap?.(null);
      clusterer = null;
    }

    // --- Uniform cluster renderer (single color) ---
    const useAdvanced = !!google.maps.marker?.AdvancedMarkerElement;
    const CLUSTER_BG = '#4f46e5'; // brand blue
    const CLUSTER_FG = '#ffffff';

    function makeClusterEl(count) {
      const el = document.createElement('div');
      el.style.cssText = `
        width:38px;height:38px;border-radius:14px;
        display:grid;place-items:center;
        background:${CLUSTER_BG}; color:${CLUSTER_FG};
        font:800 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        border:2px solid #fff;
        box-shadow:0 2px 0 rgba(0,0,0,.25),0 0 0 6px rgba(79,70,229,.20);
        user-select:none`;
      el.textContent = String(count);
      return el;
    }

    const renderer = {
      render: ({ count, position }) => {
        if (useAdvanced) {
          return new google.maps.marker.AdvancedMarkerElement({
            position,
            content: makeClusterEl(count),
            zIndex: 100 + count
          });
        }
        return new google.maps.Marker({
          position,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 18,
            fillColor: CLUSTER_BG,
            fillOpacity: 0.95,
            strokeColor: '#7c3aed',
            strokeWeight: 4
          },
          label: {
            text: String(count),
            color: CLUSTER_FG,
            fontSize: '12px',
            fontWeight: '700'
          },
          zIndex: 100 + count
        });
      }
    };

    // One handler used for all wiring styles
    const handleClusterClick = (ev) => {
      const mk = ev?.markers || ev?.cluster?.markers || [];
      if (!mk.length) return;

      const bounds = new google.maps.LatLngBounds();
      mk.forEach(m => {
        const p = m.getPosition?.() || m.position;
        if (p) bounds.extend(p);
      });

      // Save current view (your back stack) and zoom to cluster
      if (!bounds.isEmpty?.()) {
        pushView(snapshotView());
        map.fitBounds(bounds, 48);
      }

      // After map settles, flash the revealed markers
      google.maps.event.addListenerOnce(map, 'idle', () => {
        requestAnimationFrame(() => setTimeout(() => {
          flashVenueMarkers(mk);
        }, 50));
      });
    };

    // Construct the clusterer
    clusterer = new Ctor({
      map,
      markers: venueMarkers,
      ...(SuperClusterAlgo ? { algorithm: new SuperClusterAlgo({ radius: 80 }) } : {}),
      renderer,                 // <- uniform color
      onClusterClick: handleClusterClick
    });

    // Robust fallback wiring for other builds
    if (clusterer.addListener) {
      clusterer.addListener('clusterclick', handleClusterClick);
      clusterer.addListener('click', handleClusterClick);
    }
  }

   
    // --- Venue windowed caching (30 min TTL) -------------------------------
    // In-memory cache (fast) + sessionStorage (persist across navigations).
    const VENUE_CACHE_TTL_MS = 30 * 60 * 1000;
    const _venueCacheMem = new Map();
    const _venueInflight = new Map(); // coalesce concurrent requests by key

    // Build a stable "window key" from rounded bounds + zoom + limit.
    // Rounding to 3 decimals ≈ 110m which is a good map-window granularity.
    function venueCacheKey(n, e, s, w, z, limit) {
      const r = (x) => (x == null ? 'x' : x.toFixed(3));
      return `v1|z${Math.round(z)}|${r(n)},${r(e)},${r(s)},${r(w)}|L${limit}`;
    }

    function venueCacheGet(key) {
      const now = Date.now();

      // 1) Hot in-memory hit
      const mem = _venueCacheMem.get(key);
      if (mem && now - mem.t < VENUE_CACHE_TTL_MS) return mem.data;

      // 2) Warm sessionStorage hit
      try {
        const raw = sessionStorage.getItem('venue_cache_' + key);
        if (raw) {
          const obj = JSON.parse(raw);
          if (obj && now - obj.t < VENUE_CACHE_TTL_MS) {
            _venueCacheMem.set(key, obj); // promote to memory
            return obj.data;
          } else {
            sessionStorage.removeItem('venue_cache_' + key);
          }
        }
      } catch (_) {}
      return null;
    }

    function venueCacheSet(key, data) {
      const payload = { t: Date.now(), data };
      _venueCacheMem.set(key, payload);
      try { sessionStorage.setItem('venue_cache_' + key, JSON.stringify(payload)); } catch (_) {}
    }

    // ----------------------------------------------------------------------

    function maxByZoom(z) {
      if (z < 14) return 120;
      if (z < 16) return 250;
      return 500;
    }

    function searchNearbyVenues(lat, lng) {
      clearVenues();

      // Use the current map bounds so the server can optionally filter
      const b = map.getBounds();
      const n = b?.getNorthEast()?.lat?.();
      const e = b?.getNorthEast()?.lng?.();
      const s = b?.getSouthWest()?.lat?.();
      const w = b?.getSouthWest()?.lng?.();
      const z = map.getZoom() || 14;

      MAX_VENUES = maxByZoom(z); // 120 / 250 / 500 based on zoom


      const key = venueCacheKey(n, e, s, w, z, MAX_VENUES);

      // If we already have a fresh snapshot for this window, render immediately.
      const cached = venueCacheGet(key);
      if (cached && Array.isArray(cached.venues)) {
        buildVenueMarkersFromData(cached.venues, MAX_VENUES);
        renderVenueList();
        refreshCluster();
        return;
      }

      // If a fetch for the same key is in flight, piggyback on it
      if (_venueInflight.has(key)) {
        _venueInflight.get(key).then((data) => {
          if (data && Array.isArray(data.venues)) {
            buildVenueMarkersFromData(data.venues, MAX_VENUES);
            renderVenueList();
            refreshCluster();
          } else {
            showToast('Could not load safe venues');
          }
        });
        return;
      }

      // Build URL list (same as before)
      const base = '/api/venues';
      const qs =
        `?limit=${MAX_VENUES}` +
        (n != null ? `&n=${n.toFixed(6)}` : '') +
        (s != null ? `&s=${s.toFixed(6)}` : '') +
        (e != null ? `&e=${e.toFixed(6)}` : '') +
        (w != null ? `&w=${w.toFixed(6)}` : '');

      const tryUrls = [`${base}${qs}`, `${base}/${qs}`];

      // Fire the request and remember the Promise so duplicates coalesce.
      const p = (async () => {
        let data = null;
        for (const url of tryUrls) {
          try {
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            if (res.ok) { data = await res.json(); break; }
          } catch (_) {}
        }
        return data;
      })();

      _venueInflight.set(key, p);

      p.then((data) => {
        _venueInflight.delete(key);

        if (!data || !Array.isArray(data.venues)) {
          showToast('Could not load safe venues');
          return;
        }

        // Save to cache for this window key
        venueCacheSet(key, data);

        buildVenueMarkersFromData(data.venues, MAX_VENUES);
        renderVenueList();
        refreshCluster();
      });
    }

    // Small helper to keep the fetch/cached paths DRY.
    // Builds markers and fills venueIndex exactly as renderVenueList() expects.
    function buildVenueMarkersFromData(venues, limit) {
      venues.slice(0, limit).forEach((v) => {
        const type = categorizeVenue(v) || (v.type || '').toLowerCase();
        const pos = { lat: Number(v.lat), lng: Number(v.lng) };
        const catColor = (VENUE_STYLES[type]?.bg || '#4ade80');

        let marker;
        if (google.maps.marker?.AdvancedMarkerElement) {
          const el = createVenueBadge(type);
          marker = new google.maps.marker.AdvancedMarkerElement({
          map: null, position: pos, content: el, title: v.name || 'Venue', zIndex: 10
          });
          marker.__color = catColor; // remember color for flashing
          marker.addListener('gmp-click', () => {
            selectVenueMarker(marker);
            openVenueInfoApi(v, marker);
          });
        } else {
          marker = new google.maps.Marker({
            map: null, position: pos, title: v.name || 'Venue', zIndex: 10,
            icon: {
              path: google.maps.SymbolPath.CIRCLE, scale: 6,
              fillColor: catColor, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5
            }
          });
          marker.__color = catColor;
          marker.addListener('click', () => {
            selectVenueMarker(marker);
            openVenueInfoApi(v, marker);
          });
        }

        venueMarkers.push(marker);
        venueIndex.set(String(v.id), { marker, venue: v, type });
        if (window.__rebuildOpenNowForSQI) window.__rebuildOpenNowForSQI();
      });
    }




    // ----- Toast -----
    function showToast(msg, actionLabel, action){
      let el = document.getElementById('coverage-toast');
      if (!el){
        el = document.createElement('div');
        el.id = 'coverage-toast';
        el.style.cssText = `
          position:absolute;left:50%;top:12px;transform:translateX(-50%);
          background:rgba(0,0,0,.75);color:#fff;padding:.6rem .9rem;border-radius:.8rem;
          font:500 14px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;z-index:9999;
          display:flex;align-items:center;gap:.6rem;box-shadow:0 10px 24px rgba(0,0,0,.25)`;
        mapEl.appendChild(el);
      }
      el.innerHTML = `${msg}${actionLabel ? ` <button id="coverage-action" class="btn btn-sm" style="background:#ffd166;color:#111;border:0;border-radius:.5rem;padding:.35rem .6rem;cursor:pointer">${actionLabel}</button>` : ''}`;
      el.style.display = 'flex';
   
      const actBtn = el.querySelector('#coverage-action');
      actBtn && (actBtn.onclick = (e) => { action?.(); el.style.display = 'none'; });


      clearTimeout(el._hid);
      el._hid = setTimeout(() => { el.style.display = 'none'; }, 5000);


      const closeBtn = el.querySelector('#coverage-close');
      if (closeBtn) {
        closeBtn.onclick = () => { el.style.display = 'none'; };
      }
    }


    // --- Notifications (Web Notifications + in-page fallback) ---
    const Notify = {
      canUse() { return 'Notification' in window; },
      async ensurePerm() {
        if (!this.canUse()) return false;
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        const r = await Notification.requestPermission();
        return r === 'granted';
      },
      fire({ title, body, severity = 'low' }) {
        const color = ({low:'#f59e0b', medium:'#fb923c', high:'#ef4444'})[severity] || '#64748b';
        // Fallback toast (works even if Notifications are blocked)
        showToast(`<div style="display:flex;gap:.6rem;align-items:flex-start">
          <span style="display:inline-block;width:.85rem;height:.85rem;margin-top:.2rem;border-radius:50%;background:${color}"></span>
          <div><div style="font-weight:800">${title}</div><div class="small" style="opacity:.9">${body}</div></div>
        </div>`);

        if (!this.canUse() || Notification.permission !== 'granted') return;
        try { new Notification(title, { body }); } catch {}
      }
    };


    // ----- Initial venue search / debounced -----
    const debounce=(fn,wait)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),wait); }; };
    const venuesToggleOn = ()=> state.venues;
    const maybeSearch=()=>{
      if(!venuesToggleOn()) return;
      const c=map.getCenter(); if(!c) return;
      const z=map.getZoom()||14;
      const cur={lat:c.lat(),lng:c.lng(),zoom:z};
      if(lastQuery && (Math.abs(cur.lat-lastQuery.lat)+Math.abs(cur.lng-lastQuery.lng))<=0.01 && Math.abs((lastQuery.zoom||z)-z)<1) return;
      lastQuery=cur; searchNearbyVenues(cur.lat,cur.lng);
    };
    google.maps.event.addListenerOnce(map,'idle', async ()=>{ await ensureCityLighting(); if (state.venues) maybeSearch(); });
    map.addListener('idle', debounce(maybeSearch,350));

    // ----- Score UI (inert while USE_ROUTE_SCORE=false) -----
    // const scorePill = document.createElement('div');
    // scorePill.id='gw-score-pill';
    // scorePill.className='gw-score-pill';
    // scorePill.textContent='Safety score';
    // scorePill.style.position='relative';
    // scorePill.style.pointerEvents='auto';
    // overlayDock.appendChild(scorePill);

    // const scoreToast = document.createElement('div');
    // scoreToast.id='gw-score-toast';
    // scoreToast.className='gw-score-toast';
    // scoreToast.style.position='relative';
    // scoreToast.style.pointerEvents='auto';
    // overlayDock.appendChild(scoreToast);

    // scorePill.addEventListener('click',()=>{ if (USE_ROUTE_SCORE) { scoreToast.style.display = (scoreToast.style.display==='block')?'none':'block'; updateMapPadding(); }});
    // function hideScoreToast(){ scoreToast.style.display = 'none'; }

    // ----- Routing -----
    const originInput=document.getElementById('gw-origin');
    const destInput  =document.getElementById('gw-dest');
    const btnSwap    =document.getElementById('gw-swap');
    const btnRoute   =document.getElementById('gw-route');
    const btnClear   =document.getElementById('gw-clear');

    if (originInput){
      const acO=new google.maps.places.Autocomplete(originInput,{ fields:['geometry','name','formatted_address'], bounds:CITY_BOUNDS, strictBounds:true, componentRestrictions:{country:'au'} });
      acO.addListener('place_changed',()=>{ const p=acO.getPlace(); originLatLng=p?.geometry?.location||null; });
    }
    if (destInput){
      const acD=new google.maps.places.Autocomplete(destInput,{ fields:['geometry','name','formatted_address'], bounds:CITY_BOUNDS, strictBounds:true, componentRestrictions:{country:'au'} });
      acD.addListener('place_changed',()=>{ const p=acD.getPlace(); destLatLng=p?.geometry?.location||null; });
    }
    btnSwap?.addEventListener('click', ()=>{ const t=originInput.value; originInput.value=destInput.value; destInput.value=t; const tmp=originLatLng; originLatLng=destLatLng; destLatLng=tmp; });

    const directionsSvc=new google.maps.DirectionsService();
    const directionsRndr=new google.maps.DirectionsRenderer({ map, suppressMarkers:false, preserveViewport:false, suppressPolylines:true });
    // Keep marker visibility in sync with whether directions exist
    directionsRndr.addListener('directions_changed', () => {
      const d = directionsRndr.getDirections();
      const any = !!(d && d.routes && d.routes.length);
      setRoutePresence(any);
    });

    const routePolyline = new google.maps.Polyline({
      map, strokeOpacity: 0, strokeWeight: 7, zIndex: 30, clickable: false
    });

    const routeHalo = new google.maps.Polyline({
      map,
      strokeOpacity: 0,
      strokeWeight: 10,       
      strokeColor: '#ffffff',
      zIndex: 29,
      clickable: false        
    });

    function clearRouteCompletely() {
  // 1) Clear DirectionsRenderer / main polyline / halo
  try { directionsRndr.setDirections({ routes: [] }); } catch {}
  // Optional: keep the renderer on the map (or remove with setMap(null))
  // directionsRndr.setMap(map);

  routePolyline.setPath([]);
  routeHalo.setPath([]);

  // 2) Clear mid badges / compare drawer / any attached listeners
  window.__clearPrefDecorations?.();
  window.__wwi_lastCandidates = null;

  // 3) Reset state & UI
  setRoutePresence(false);
  toggleCompare?.(false);
}
btnClear?.addEventListener('click', clearRouteCompletely);

    /* ========= Route preference (segmented icons) + primary/alternate rendering ========= */
(function routePreferenceModule(){
  const PREF_KEY = 'wwi.pref.route';
  const bar = document.getElementById('wwi-prefbar');
  if (!bar) return;

  // keep all zoom listeners we attach for mid badges
  const _prefZoomListeners = new Set();

  // Restore persisted preference (default: auto)
  let pref = localStorage.getItem(PREF_KEY) || 'auto';
  setSelected(pref);

  // Listen clicks on the three segmented buttons
  bar.querySelectorAll('.wwi-prefbtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      pref = btn.dataset.pref;
      localStorage.setItem(PREF_KEY, pref);
      setSelected(pref);
      // Re-apply on last candidates if available
      if (window.__wwi_lastCandidates) applyPreference(window.__wwi_lastCandidates);
    });
  });

  function setSelected(p){
    bar.querySelectorAll('.wwi-prefbtn').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.pref===p));
    });
  }

  // Secondary (alternate) line + mid badge (label near mid point)
  let altLine = null, altBadge = null;
  let primaryBadge = null;

  // Track every mid badge so we can reliably clear them
  const midBadges = new Set();

  /** Place a small rounded badge around the mid-point of the route. */
  function showMidBadge(route, text, opts = {}){
    try{
      const pts = route.path || [];
      const mid = pts[Math.floor(pts.length/2)];
      const el = document.createElement('div');
      el.style.cssText =
        `padding:.25rem .5rem;border-radius:999px;font:900 12px/1 system-ui;` +
        (opts.muted ? `background:#e5e7eb;color:#111;border:1px solid #d1d5db`
                    : `background:#111827;color:#fff;border:1px solid rgba(255,255,255,.18)`);
      el.textContent = text;

      const m = new google.maps.marker.AdvancedMarkerElement({
        map, position: mid, content: el, zIndex: 40
      });

      // Track & auto-prune when removed
      midBadges.add(m);
      m.addListener?.('map_changed', () => { if (!m.map) midBadges.delete(m); });

      const setVis = () => m.map = (map.getZoom() >= 14) ? map : null;
      // setVis(); google.maps.event.addListener(map, 'zoom_changed', setVis);
      const l = google.maps.event.addListener(map, 'zoom_changed', setVis);
      _prefZoomListeners.add(l);

      return m;
    }catch{ return null; }
  }


  window.__clearPrefDecorations = function () {
    if (altLine) altLine.setPath([]);
    if (altBadge) { altBadge.map = null; altBadge = null; }
    if (primaryBadge) { primaryBadge.map = null; primaryBadge = null; }
    // Clear any stray mid badges
    midBadges.forEach(m => { try { m.map = null; } catch {} });
    midBadges.clear();
    //remove the zoom listeners we attached for badges
    _prefZoomListeners.forEach(l => { try { l.remove(); } catch { google.maps.event.removeListener(l); } });
    _prefZoomListeners.clear();
    if (compareInner) compareInner.innerHTML = '';
    toggleCompare(false);
  };
  function drawAlt(route){
  if (!route) return clearAlt();

  clearAlt();
  if (!altLine) altLine = new google.maps.Polyline({ map, clickable:false, zIndex:28 });

  altLine.setPath(route.path);
  altLine.setOptions({

    strokeOpacity: 0,
    icons: [{
      icon: {
        path: 'M 0,-1 0,1',
        strokeOpacity: 1,
        strokeWeight: 4,
        strokeColor: '#000',
        scale: 1.2
      },
      offset: '0',
      repeat: '14px'
    }]
  });

  altBadge = showMidBadge(route, route.kind, { muted:true });
}

  function clearAlt(){ if (altLine) altLine.setPath([]); if (altBadge) altBadge.map = null; }


  function colorByLabel(label){
    return ({ green:'#16a34a', yellow:'#f59e0b', red:'#ef4444' }[label] || '#7c3aed');
  }

  /** Draw primary line and halo. Mode 'safety' uses score color; 'brand' uses purple. */
  function drawPrimary(route, mode){
    routeHalo.setPath(route.path);
    routeHalo.setOptions({ strokeOpacity:.75, strokeColor:'#fff', strokeWeight:10 });

    const color = (mode==='safety') ? colorByLabel(route.label) : '#7c3aed';
    routePolyline.setPath(route.path);
    routePolyline.setOptions({ strokeColor:color, strokeOpacity:.98, strokeWeight:7 });
    
    if (primaryBadge) { primaryBadge.map = null; primaryBadge = null; }
    primaryBadge = showMidBadge(route, route.kind);
    // showMidBadge(route, route.kind);
  }

  // One-time nudge: suggest switching preference if the other route looks better
  let nudgedOnce = false;
  function maybeNudge({ pref, safer, shorter, primaryIsSafer }){
    if (nudgedOnce) return;
    const sA = safer?.score ?? 0, sB = shorter?.score ?? 0;
    if (pref==='safer' && sB > sA){
      nudgedOnce = true;
      showToast?.(`Heads-up: the shorter route looks safer (${Math.round(sB*100)}% vs ${Math.round(sA*100)}%).`, 'Use Shorter', ()=>setPref('shorter'));
    }else if (pref==='shorter' && sA > sB){
      nudgedOnce = true;
      showToast?.(`Heads-up: the safer route has a higher safety score (${Math.round(sA*100)}%).`, 'Use Safer', ()=>setPref('safer'));
    }
  }
  function setPref(p){
    pref = p; localStorage.setItem(PREF_KEY, p); setSelected(p);
    if (window.__wwi_lastCandidates) applyPreference(window.__wwi_lastCandidates);
  }

  /** Render the drawer rows for primary/secondary routes. */
  function renderCompare({ primary, secondary }){
    if (!compareInner) return;
    const rowHtml = r => `
      <div class="wwi-compare-row" data-k="${r.key}">
        <span class="wwi-tag ${r.key==='safer' ? 'wwi-tag--safer' : 'wwi-tag--shorter'}">${r.kind}</span>
        <div class="wwi-metrics">
          <span>Safety: <b>${Math.round((r.score || 0)*100)}%</b> (${String(r.label||'').toUpperCase()||'—'})</span>
          <span>Distance: <b>${r.distanceText||'-'}</b></span>
          <span>Time: <b>${r.durationText||'-'}</b></span>
        </div>
        <button class="wwi-make-primary" type="button">Make primary</button>
      </div>`;
    compareInner.innerHTML = rowHtml(primary) + (secondary ? rowHtml(secondary) : '');
    compareInner.querySelectorAll('.wwi-make-primary').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const k = btn.closest('.wwi-compare-row')?.dataset.k;
        if (!k) return;
        setPref(k); toggleCompare(false);
      });
    });
  }

  // Expose hook to be called after you get route candidates
  window.__applyPrefForRoutes = function(candidates){
    window.__wwi_lastCandidates = candidates;
    applyPreference(candidates);
  };

  /** Apply the chosen preference to decide primary/secondary and update UI. */
  function applyPreference({ safer, shorter }){
    const same = !!(safer?.encoded && shorter?.encoded && safer.encoded===shorter.encoded);
    let primary, secondary, primaryIsSafer;

    if (pref==='safer'){ primary=safer;   secondary=shorter; primaryIsSafer=true; }
    else if (pref==='shorter'){ primary=shorter; secondary=safer; primaryIsSafer=false; }
    else {
      const a = safer?.score ?? 0, b = shorter?.score ?? 0;
      if (a>b){ primary=safer; secondary=shorter; primaryIsSafer=true; }
      else if (b>a){ primary=shorter; secondary=safer; primaryIsSafer=false; }
      else { primary=shorter; secondary=safer; primaryIsSafer=false; } // tie → prefer shorter
    }

    // Draw primary & alt
    drawPrimary(primary, primaryIsSafer ? 'safety' : 'brand');
    same ? clearAlt() : drawAlt(secondary);

    // Update pill text & drawer content
    const pct = Math.round((primary?.score||0)*100);
    const txt = ensurePillTextNode();
    if (txt) {
      txt.textContent = `Safety Score: ${(primary?.label || '').toString().toUpperCase()} • ${pct}%`;
    }
    renderCompare({ primary, secondary });
    scorePillEl.setAttribute('aria-expanded','false');
    toggleCompare(false);

    // === ADD: announce Auto decision once per change ===
    if (pref === 'auto') {
      //showAutoDecisionToast({ safer, shorter, primaryIsSafer });
    }

    // Optional nudge
    maybeNudge({ pref, safer, shorter, primaryIsSafer });
  }
})();

    // after you create btnRoute / inputs:
      function updateRouteCta() {
        const hasOrigin = !!(originLatLng || originInput?.value.trim());
        const hasDest   = !!(destLatLng   || destInput?.value.trim());

        btnRoute.textContent = (hasOrigin && hasDest) ? 'Directions' : 'Go';
        btnRoute.setAttribute('aria-label',
          (hasOrigin && hasDest) ? 'Show walking directions' : 'Set route origin and destination');
      }

      // run on load and when fields change
      updateRouteCta();
      [originInput, destInput].forEach(inp => inp?.addEventListener('input', updateRouteCta));

      // Optional: when a route is already shown, change CTA to “Update”
      function onRouteDrawn() {
        btnRoute.textContent = 'Update';
        btnRoute.setAttribute('aria-label', 'Update directions');
      }


    function openExternalNav(path, startLoc, endLoc) {
      const ll = (p) => `${p.lat().toFixed(6)},${p.lng().toFixed(6)}`;
      const sample = (arr, maxPts = 8) => {
        if (!arr || arr.length <= 2) return [];
        const step = Math.ceil(arr.length / maxPts);
        return arr.filter((_, i) => i % step === 0).slice(1, -1);
      };
      const wps = sample(path).map(ll).join("|");
      const isApple = /iP(hone|od|ad)/.test(navigator.platform);
      const gmaps = `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${ll(startLoc)}&destination=${ll(endLoc)}` + (wps ? `&waypoints=${encodeURIComponent(wps)}` : "");
      const amap = `maps://?saddr=${ll(startLoc)}&daddr=${ll(endLoc)}&dirflg=w`;
      window.open(isApple ? amap : gmaps, "_blank");
    }

    function encodePolylineFromPath(path){
      const coords = path.map(p => ({ lat: (typeof p.lat === 'function') ? p.lat() : p.lat, lng: (typeof p.lng === 'function') ? p.lng() : p.lng }));
      let lastLat = 0, lastLng = 0, result = '';
      function encode(value){ value = value < 0 ? ~(value << 1) : (value << 1); while (value >= 0x20) { result += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>= 5; } result += String.fromCharCode(value + 63); }
      for (const {lat, lng} of coords){ const latE5 = Math.round(lat * 1e5); const lngE5 = Math.round(lng * 1e5); encode(latE5 - lastLat); encode(lngE5 - lastLng); lastLat = latE5; lastLng = lngE5; }
      return result;
    }
    function getEncodedPolyline(directionsResult){
      const r = directionsResult?.routes?.[0]; if (!r) return null;
      const op = r.overview_polyline;
      if (op){ if (typeof op === 'string') return op; if (typeof op.points === 'string') return op.points; }
      if (Array.isArray(r.overview_path) && r.overview_path.length){ return encodePolylineFromPath(r.overview_path); }
      return null;
    }

    







function fmtWhenRange(startISO, endISO){
  const opt = { hour:'2-digit', minute:'2-digit', month:'short', day:'numeric' };
  const s = startISO ? new Date(startISO).toLocaleString(undefined, opt) : '';
  const e = endISO   ? new Date(endISO).toLocaleString(undefined, opt)   : '';
  if (s && e) return `${s} → ${e}`;
  if (s) return `Starts ${s}`;
  if (e) return `Until ${e}`;
  return 'Time unknown';
}

// Derive activeNow flag from start/end
function isActiveNow(startISO, endISO){
  const now = Date.now();
  const s = startISO ? Date.parse(startISO) : null;
  const e = endISO ? Date.parse(endISO) : null;
  if (s && e) return s <= now && now <= e;
  if (s && !e) return s <= now;
  if (!s && e) return now <= e;
  return false;
}


// disruptions 
function stableDisruptionId(p) {
  const id =
    p.id ??
    p.eventId ??
    p.source?.id ??
    p.activityId ??
    `${p.title || ''}|${p.when?.start || ''}|${p.when?.end || ''}|${p.marker?.lat ?? ''},${p.marker?.lon ?? ''}`;
  return String(id);
}


// Map raw feature -> clean object for the list
function mapFeatureToCard(f){
  const p = f.properties || {};
  const when = p.when || {};
  const coords = p.marker || {};
  //const id = String(p.id ?? p.source?.id ?? `${p.title}-${Math.random().toString(36).slice(2,8)}`);
  const id = stableDisruptionId(p);
  return {
    id,
    title: p.title || 'Planned disruption',
    status: p.status || '',
    eventType: p.eventType || 'Roadworks',
    eventSubtype: p.eventSubType || p.eventSubtype || '',
    startISO: when.start || null,
    endISO: when.end || null,
    activeNow: isActiveNow(when.start, when.end),
    impact: p.impact || '',
    description: p.description || '',
    lanes: p.lanes || (p.roadStatus || ''),
    distance_m: (typeof p.distance_m === 'number') ? p.distance_m : null,
    coords: (coords.lat!=null && coords.lon!=null) ? { lat: coords.lat, lng: coords.lon } : null,
    sourceName: p.source?.sourceName || '',
  };
}


function dedupeById(features){
  const byId = new Map();
  for (const f of (features || [])) {
    const p = f.properties || {};
    const id = stableDisruptionId(p);
    const prev = byId.get(id);
    if (!prev) { byId.set(id, f); continue; }

    const a = p.distance_m ?? Infinity;
    const b = prev.properties?.distance_m ?? Infinity;
    const actA = isActiveNow(p.when?.start, p.when?.end);
    const actB = isActiveNow(prev.properties?.when?.start, prev.properties?.when?.end);

    if ((actA && !actB) || (a < b)) byId.set(id, f);
  }
  return [...byId.values()];
}

// Severity -> chip class
function chipBySeverity(sev){
  switch(sev){
    case 'high':   return 'gw-chip gw-chip--red';
    case 'medium': return 'gw-chip gw-chip--orange';
    case 'low':    return 'gw-chip gw-chip--amber';
    default:       return 'gw-chip gw-chip--gray';
  }
}

// Panel renderer
function renderDisruptionsList(cards, summary){
  const host = document.getElementById('disruptions-panel');
  if (!host) return;
  const listEl   = document.getElementById('disruptions-list');
  const sumEl    = document.getElementById('disruptions-summary');
  const metEl    = document.getElementById('disruptions-metrics');
  const emptyEl  = document.getElementById('disruptions-empty');

  // Show/hide panel
  const hasAny = Array.isArray(cards) && cards.length > 0;
  host.classList.toggle('d-none', !hasAny);
  if (!hasAny){
    if (emptyEl) emptyEl.classList.remove('d-none');
    if (listEl)  listEl.innerHTML = '';
    if (sumEl)   sumEl.innerHTML = '';
    if (metEl)   metEl.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.classList.add('d-none');

  // Top summary chips
  const sev = summary?.severity || 'low';
  const sevTxt = ({none:'None',low:'Low',medium:'Medium',high:'High'})[sev] || 'Low';
  const sevCls = chipBySeverity(sev);

  if (sumEl){
    sumEl.innerHTML = `
      <span class="gw-chip gw-chip--amber">Active now: ${summary?.activeNow ?? 0}</span>
      <span class="gw-chip gw-chip--gray">Total nearby: ${summary?.count ?? cards.length}</span>
      <span class="${sevCls}">Severity: ${sevTxt}</span>
    `;
  }

  // Metric tiles (optional mini KPIs)
  if (metEl){
    metEl.innerHTML = `
      <span class="gw-chip gw-chip--gray">Click a card to focus on map</span>
      <span class="gw-chip gw-chip--gray">Radius: ~1 km</span>
    `;
  }

  // List rows
  if (listEl){
    listEl.innerHTML = cards.map(c => {
      const when = fmtWhenRange(c.startISO, c.endISO);
      const activeCls = c.activeNow ? 'gw-chip gw-chip--amber' : 'gw-chip gw-chip--gray';
      const badge = c.status || c.eventSubtype || c.eventType || '';
      const dist = (typeof c.distance_m === 'number') ? `${Math.round(c.distance_m)} m` : '';
      return `
        <div class="gw-dcard" data-id="${c.id}">
          <div class="gw-dhead">
            <div>
              <div class="gw-dtitle">${c.title}</div>
              <div class="gw-dmeta">
                <span class="${activeCls}">${c.activeNow ? 'Active now' : 'Scheduled'}</span>
                ${badge ? `<span class="gw-chip gw-chip--gray">${badge}</span>` : ''}
                ${dist ? `<span class="gw-chip gw-chip--gray">${dist} from route</span>` : ''}
              </div>
            </div>
            <button type="button" class="gw-dbtn" data-act="focus">View on map</button>
          </div>
          ${c.impact ? `<div class="gw-dimpact mt-1">Impact: ${c.impact}</div>` : ''}
          ${c.lanes ? `<div class="small mt-1" style="opacity:.85">Lanes: ${c.lanes}</div>` : ''}
          <div class="small mt-1">${when}</div>
          ${c.description ? `<details class="gw-dmore"><summary class="gw-link">Details</summary><div class="small mt-1">${c.description}</div></details>` : ''}
        </div>`;
    }).join('');
  }

  // Click -> pan/zoom to marker
  listEl?.querySelectorAll('.gw-dcard').forEach(row => {
    const id = row.dataset.id;
    row.addEventListener('click', (ev) => {
      const isBtn = (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-act') === 'focus');
      const card = _disruptionCardsIndex.get(id);
      if (!card) return;
      const m = _disruptionMarkerIndex.get(id);
      const pos = m?.getPosition?.() || m?.position || card.coords;
      if (pos){
        const ll = (pos.lat ? pos : new google.maps.LatLng(pos.lat, pos.lng));
        map.panTo(ll);
        map.setZoom(Math.max(map.getZoom() || 14, 16));
        if (m?.content){ m.content.classList.add('gw-pulse'); setTimeout(()=> m.content.classList.remove('gw-pulse'), 1000); }
      }
      if (isBtn) ev.stopPropagation();
    });
  });
}

// Local indices so the list can focus markers quickly
const _disruptionMarkerIndex = new Map();  // id -> marker
const _disruptionCardsIndex  = new Map();  // id -> card
let _disruptionsScrolledOnce = false;      // auto-scroll guard



    // Disruptions
    let disruptionMarkers = [];
    let disruptionSummary = null;
    let disruptionReqId = 0;
    let lastDirectionsResult = null;
    const __DISRUPTION_TOAST__ =true;   
    const __DISRUPTION_IW__    = true; 


    const disruptionIW = __DISRUPTION_IW__ ? new google.maps.InfoWindow({ maxWidth: 420 }) : null;
    let currentDisruptionFeatures = [];           // raw features from API
    const _notifiedIds = new Map();        


    function openDisruptionSkeletonAt(latLng){
      
    }

    function summariseDisruptions(features){
      let level = 0;
      for (const f of features){
        const p = f.properties || {};
        const txt = [p.impact,p.title,p.eventType,p.eventSubType,p.description,p.lanes,p.roadStatus].filter(Boolean).join(' ').toLowerCase();
        if (/(full|complete)\s*clos|detour|closed\b|no access|blocked/.test(txt)) level = Math.max(level, 3);
        else if (/(lane|shoulder|speed|reduced|stop\/?go|traffic control|contra\s*flow)/.test(txt)) level = Math.max(level, 2);
        else if (txt.trim()) level = Math.max(level, 1);
      }
      const colors = ['#16a34a','#f59e0b','#fb923c','#ef4444'];
      const activeNow = features.filter(f => {
        const when = f.properties?.when; const now = new Date();
        if (!when) return true;
        const s = when.start ? new Date(when.start) : null;
        const e = when.end ? new Date(when.end) : null;
        if (s && e) return s <= now && now <= e;
        if (s && !e) return s <= now;
        if (!s && e) return now <= e;
        return true;
      }).length;
      features.sort((a,b)=>{ const ra = a.properties?.impact||'', rb = b.properties?.impact||''; return String(rb).localeCompare(String(ra)); });
      return { count: features.length, activeNow, severity: ['none','low','medium','high'][level], color: colors[level] };
    }

    function severityForFeature(f) {
      const p = f?.properties || {};
      const txt = [p.impact,p.title,p.eventType,p.eventSubType,p.description,p.lanes,p.roadStatus]
        .filter(Boolean).join(' ').toLowerCase();

      if (/(full|complete)\s*clos|detour|closed\b|no access|blocked/.test(txt)) return 'high';
      if (/(lane|shoulder|speed|reduced|stop\/?go|traffic control|contra\s*flow)/.test(txt)) return 'medium';
      if (txt.trim()) return 'low';
      return 'low';
    }



    function createDisruptionBadge(){
      const el = document.createElement('div');
      el.style.cssText = 'width:26px;height:26px;border-radius:10px;display:grid;place-items:center;background:#fb923c;color:#111;font-size:16px;line-height:1;border:2px solid #fff;box-shadow:0 1px 0 rgba(0,0,0,.45),0 0 0 3px rgba(251,146,60,.25);user-select:none;';
      el.textContent = '🚧';
      return el;
    }

    function disruptionToastHtml(props){
      const title = props?.title || 'Planned disruption';
      const impact = props?.impact ? `<div class="small" style="opacity:.85">Impact: ${props.impact}</div>` : '';
      const lanes  = props?.lanes  ? `<div class="small" style="opacity:.85">Lanes: ${props.lanes}</div>` : '';
      const when   = props?.when;
      const whenRow = (when && (when.start || when.end))
        ? `<div class="small">When: ${when.start ? new Date(when.start).toLocaleString() : ''} → ${when.end ? new Date(when.end).toLocaleString() : ''}</div>`
        : '';
      const dist   = (typeof props?.distance_m === 'number') ? `<div class="small" style="opacity:.7">${props.distance_m} m from route</div>` : '';
      const desc   = props?.description ? `<div style="margin-top:.4rem">${props.description}</div>` : '';
      return `<div style="max-width:420px"><div style="font-weight:700;margin-bottom:.25rem">${title}</div>${impact}${lanes}${whenRow}${dist}${desc}</div>`;
    }



// ---- In-flight guard for /api/disruptions/along-route (added once) ----
// Holds the latest request id and its AbortController so we can cancel older ones.
window._disruptionsInflight ||= { id: 0, controller: null };

/** Lightweight "preflight" that clears stale UI and shows a loading row. */
function preflightDisruptionsUI() {
  // Ensure shell exists and theme is applied (reuses your own helpers)
  const panel = (typeof ensureDisruptionsPanelShell === 'function')
      ? ensureDisruptionsPanelShell() : document.getElementById('disruptions-panel');
  if (!panel) return;
  (typeof applyPanelTheme === 'function') && applyPanelTheme(panel);

  const tbody = panel.querySelector('#disruptions-tbody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:16px">
        <em>Loading nearby…</em>
      </td></tr>`;
  }
  const tEl = panel.querySelector('#dp-chip-total .n');
  const sEl = panel.querySelector('#dp-chip-sev .n');
  if (tEl) tEl.textContent = '…';
  if (sEl) sEl.textContent = '…';

  // Make sure the panel becomes visible again (you hide it in clearRoute)
  panel.style.removeProperty('display');
}

// ===== Compare drawer in-flight guard (Safer / Shorter) =====
window._compareInflight ||= { id: 0, controller: null };

function preflightCompareUI(mode = 'hide') {
  const box   = document.getElementById('wwi-compare');
  const inner = document.querySelector('#wwi-compare .wwi-compare-inner');
  if (!box) return;

  if (mode === 'hide') {
    box.hidden = true;
    box.dataset.pending = '1';
    if (inner) inner.innerHTML = '';
    return;
  }

  // skeleton loading
  box.removeAttribute('hidden');
  box.dataset.pending = '1';
  if (inner) {
    inner.innerHTML = `
            <div class="wwi-compare-row loading">
        <span class="wwi-tag">Comparing…</span>
        <div class="wwi-metrics">
          <span>Safety: <b>Comparing…</b></span>
          <span>Distance: —</span>
          <span>Time: —</span>
        </div>
        <button class="wwi-make-primary" type="button" disabled>…</button>
      </div>`;
  }
  toggleCompare?.(true);
  document.getElementById('gw-score-pill')?.setAttribute('aria-expanded','true');
}

function revealCompareUI() {
  const box = document.getElementById('wwi-compare');
  if (!box) return;
  delete box.dataset.pending;
  box.removeAttribute('hidden');
}




    // 4-A) fetchAndRenderDisruptions — removed "Active now", fixed Action column, kept GSAP
async function fetchAndRenderDisruptions(directionsResult, radiusM = 200, reqId = 0, openAtLatLng = null) {
  // console.count('renderDisruptions');
  // Guard: need encoded polyline
  const enc = getEncodedPolyline(directionsResult);

  if (!enc) return;


    // ---- Concurrency: cancel previous fetch, mark UI as loading immediately ----
  const inflight = (window._disruptionsInflight ||= { id: 0, controller: null });

  // Bump to a new id (prefer caller's reqId if provided)
  inflight.id = reqId || (inflight.id + 1);
  const myReqId = inflight.id;

  // Abort the previous request so it cannot arrive late and flicker the UI
  try { inflight.controller?.abort(); } catch (_) {}
  inflight.controller = new AbortController();

  // Remove stale markers NOW (avoid seeing old pins while new route is computing)
  try {
    disruptionMarkers.forEach(m => (m.map !== undefined) ? (m.map = null) : m.setMap(null));
    disruptionMarkers = [];
    _disruptionMarkerIndex.clear();
  } catch (_) {}

  // Put the panel into a loading state right away
  preflightDisruptionsUI();


  // Ensure GSAP available for micro-animations
  await ensureGSAP();


  // Lazy globals (avoid editing outer scope)
  /** @type {Map<string, google.maps.Marker|google.maps.marker.AdvancedMarkerElement>} */
  const _disruptionMarkerIndex = (window._disruptionMarkerIndex ||= new Map());
  /** @type {Map<string, any>} raw card/row data by id */
  const _disruptionCardsIndex  = (window._disruptionCardsIndex ||= new Map());
  if (window._disruptionsScrolledOnce == null) window._disruptionsScrolledOnce = false;

  // ---------- CSS (inject once) ----------
  function ensureDisruptionsTableCSS() {
  if (document.getElementById('gw-disruptions-css')) return;
  const s = document.createElement('style');
  s.id = 'gw-disruptions-css';
  s.textContent = `
/* ===================== THEME TOKENS ===================== */
:root{
  --gw-surface:#0b1220;--gw-surface-2:#111827;--gw-surface-3:#0f172a;
  --gw-border:rgba(255,255,255,.08);--gw-text:#e5e7eb;--gw-muted:#94a3b8;
  --gw-row-hover:rgba(255,255,255,.06);--gw-chip-fg:var(--gw-text);
  --gw-btn-bg:#ffd166;--gw-btn-fg:#111827;--gw-hi:#fb923c30;
}
[data-theme="bright"],.theme-bright,.bright,body.light,body.bright-mode{
  --gw-surface:#ffffff;--gw-surface-2:#f3f5f9;--gw-surface-3:#ffffff;
  --gw-border:rgba(17,24,39,.10);--gw-text:#111827;--gw-muted:#475569;
  --gw-row-hover:rgba(17,24,39,.05);--gw-chip-fg:#0f172a;--gw-hi:#fb923c24;
  --gw-btn-bg:#ffd166;--gw-btn-fg:#111827;
}
@media (prefers-color-scheme: light){
  :root{ --gw-surface:#ffffff;--gw-surface-2:#f3f5f9;--gw-surface-3:#ffffff;
    --gw-border:rgba(17,24,39,.10);--gw-text:#111827;--gw-muted:#475569;
    --gw-row-hover:rgba(17,24,39,.05);--gw-chip-fg:#0f172a;--gw-hi:#fb923c24; }
}

/* ===================== WRAPPER & HEAD ===================== */
.gw-dwrap{ margin:1rem 0 1.5rem; border:1px solid var(--gw-border);
  background:var(--gw-surface); border-radius:14px; padding:14px 14px 8px;
  box-shadow:0 6px 20px rgba(0,0,0,.12); color:var(--gw-text);}
.gw-dheadbar{ display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:.4rem;}
.gw-dtitlewrap{ display:flex; align-items:center; gap:.6rem;}
.gw-dglyph{ font-size:20px;}
.gw-dtitle{ margin:0; font:800 20px/1.1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--gw-text);}
.gw-dsubbar{ display:flex; gap:.5rem; margin-bottom:.6rem;}

/* ===================== CHIPS ===================== */
.gw-chip{ display:inline-flex; align-items:center; gap:.4rem; padding:.28rem .6rem; border-radius:999px;
  font:700 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--gw-chip-fg);
  background:rgba(100,116,139,.16); border:1px solid rgba(100,116,139,.32);}
.gw-chip b{ font-weight:800; opacity:.85; }
.gw-chip .n{ min-width:1ch; display:inline-block; text-align:right;}
.gw-chip--hint{ background:rgba(79,70,229,.14); border-color:rgba(79,70,229,.32); color:var(--gw-text);}
.gw-chip--amber{ background:#f59e0b20; color:#b45309; border:1px solid #f59e0b60;}

/* ===================== TABLE ===================== */
.gw-dtable-wrap{ overflow:auto; border-radius:12px;}
.gw-dtable{ width:100%; table-layout:fixed; border-collapse:separate; border-spacing:0;
  background:var(--gw-surface-3); border:1px solid var(--gw-border); border-radius:12px; overflow:hidden; }
.gw-dtable thead th{
  position:sticky; top:0; z-index:1; background:var(--gw-surface-2);
  color:var(--gw-muted); text-transform:uppercase; letter-spacing:.02em;
  padding:12px 16px; border-bottom:1px solid var(--gw-border);
  font:800 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
.gw-dtable tbody tr{ border-top:1px solid var(--gw-border); }
.gw-dtable tbody tr:hover{ background:var(--gw-row-hover); }
.gw-dtable td{ padding:14px 16px; vertical-align:middle; color:var(--gw-text); }

.gw-dtable thead th:nth-child(1), .gw-dtable tbody td:nth-child(1){ text-align:left; }   /* Location */
.gw-dtable thead th:nth-child(2), .gw-dtable tbody td:nth-child(2){ text-align:left; }   /* Description */
.gw-dtable thead th:nth-child(3), .gw-dtable tbody td:nth-child(3){ text-align:left; }   /* When */
.gw-dtable thead th:nth-child(4), .gw-dtable tbody td:nth-child(4){ text-align:center; } /* Distance */
.gw-dtable thead th:nth-child(5){ text-align:center; }                                     /* View */
.gw-dtable tbody td:nth-child(5){ text-align:right; }

/* Location cell */
.gw-loc-title{ font-weight:800; font-size:15px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gw-loc-sub{ font:700 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; opacity:.8; margin-top:.18rem; }

/* Description & When */
.gw-desc{ font:600 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; opacity:.95; }
.gw-when{ font:600 12px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--gw-muted); white-space:nowrap; }

/* Distance pill */
.gw-dist-pill{ display:inline-flex; align-items:center; justify-content:center; min-width:56px; height:28px; padding:0 .6rem;
  border-radius:999px; font:800 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  color:var(--gw-text); background:rgba(148,163,184,.16); border:1px solid var(--gw-border); }

/* Action column */
.gw-td-action{ text-align:right; padding-top:6px; padding-bottom:6px; }
.gw-col-action{ width:140px; }

/* Button */
.gw-dbtn{ position:relative; overflow:hidden; background:var(--gw-btn-bg); color:var(--gw-btn-fg);
  border:0; border-radius:12px; padding:.45rem .7rem; font:800 12px/1.05 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  cursor:pointer; box-shadow:0 2px 0 rgba(0,0,0,.2); }
.gw-dbtn:hover{ filter:brightness(.98); }
.gw-ripple{ position:absolute; border-radius:999px; pointer-events:none; inset:auto; width:10px; height:10px; background:rgba(17,24,39,.25); mix-blend-mode:multiply; }

/* a11y */
.visually-hidden{ position:absolute !important; height:1px; width:1px; overflow:hidden; clip:rect(1px,1px,1px,1px); white-space:nowrap; }


/* --- Make the table horizontally scrollable on narrow viewports --- */
.gw-dtable-wrap{
  overflow:auto;
  -webkit-overflow-scrolling: touch;   /* iOS smooth scroll */
  overscroll-behavior-x: contain;      /* prevent scroll chaining */
}

/* Base min-width so columns don't crush each other; wrapper will scroll */
.gw-dtable{ min-width: 760px; }

/* Small phones: hide the Description column to fit comfortably */
@media (max-width: 760px){
  /* Drop the base min-width when Description is hidden */
  .gw-dtable{ min-width: 760px; }

  /* Hide Description header & cells (2nd and 4th column) */
  .gw-dtable thead th:nth-child(2),
  .gw-dtable tbody td:nth-child(2){ display:none; }
  .gw-dtable thead th:nth-child(4),
  .gw-dtable tbody td:nth-child(4){ display:none; }

  .gw-dtable col:nth-child(2){ width: 0%;  }  /* Description (hidden) */
  .gw-dtable col:nth-child(4){ width: 0%; }  /* Distance */

  /* Optional: tighten paddings a bit on very small screens */
  .gw-dtable thead th,
  .gw-dtable td{ padding:12px 12px; }
}
`;
  document.head.appendChild(s);
}


// Build a stable, canonical id for a disruption feature
function canonDisruptionId(p) {
  // 盡量使用後端提供的穩定 id；最後才 fallback 到可複製的 composite key
  return String(
    p.id ??
    p.globalId ??
    p.source?.id ??
    p.referenceId ??
    p.reference ??
    // composite: title + road + time range + eventType
    [
      p.title || p.name || '',
      p.road || p.location || '',
      p.when?.start || '',
      p.when?.end || '',
      p.eventType || '',
      p.eventSubType || ''
    ].join('|').toLowerCase().replace(/\s+/g,' ')
  );
}

// De-dupe features by canonical id, keep the one with smallest numeric distance_m
function dedupeFeatures(feats) {
  const best = new Map(); // id -> feature
  for (const f of feats) {
    const p = f.properties || {};
    const id = canonDisruptionId(p);
    // 確保有 numeric distance
    const dm = Number(p.distance_m);
    if (!best.has(id)) {
      best.set(id, f);
      continue;
    }
    const prev = best.get(id);
    const prevDm = Number(prev?.properties?.distance_m);
    // 沒有距離就視為劣勢；有距離則保留較小者
    const prevScore = Number.isFinite(prevDm) ? prevDm : Number.POSITIVE_INFINITY;
    const currScore = Number.isFinite(dm)     ? dm     : Number.POSITIVE_INFINITY;
    if (currScore < prevScore) best.set(id, f);
  }
  return Array.from(best.values());
}


  // ---------- Panel shell ----------
  function ensureDisruptionsPanelShell() {
    let panel = document.getElementById('disruptions-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'disruptions-panel';
      const mapEl = document.getElementById('map');
      const host = mapEl?.parentElement || document.body;
      host.parentElement?.insertBefore(panel, host.nextSibling) || document.body.appendChild(panel);
    }
    if (panel.dataset.built === '1') return panel;

    panel.className = 'gw-dwrap';
    panel.innerHTML = `
      <div class="gw-dheadbar">
        <div class="gw-dtitlewrap">
          <span class="gw-dglyph">🚧</span>
          <h3 class="gw-dtitle">Route Disruptions Near Your Path</h3>
        </div>
      </div>

      <div class="gw-dtable-wrap">
        <table class="gw-dtable" role="grid" aria-label="Disruptions near your route">
          <colgroup>
            <col style="width:24%">       <!-- Location -->
            <col style="width:36%">       <!-- Description -->
            <col style="width:24%">       <!-- When -->
            <col style="width:8%">       <!-- Distance -->
            <col class="gw-col-action">   <!-- Action -->
          </colgroup>
          <thead>
            <tr>
              <th>Location</th>
              <th>Description</th>
              <th>When</th>
              <th>Distance</th>
              <th>View</th>
            </tr>
          </thead>
          <tbody id="disruptions-tbody"></tbody>
        </table>
      </div>
    `;
    
    panel.dataset.built = '1';

    // Intro animation
    if (window.gsap) {
      gsap.fromTo(panel, {autoAlpha:0, y:10}, {autoAlpha:1, y:0, duration:.35, ease:'power1.out'});
    }
    return panel;
  }

  // ---------- Theme handling (soft cross-fade) ----------
  function applyPanelTheme(panel) {
    const bright = !state.lighting; // true => light UI
    if (window.gsap) gsap.to(panel, {autoAlpha:0, duration:.12, ease:'power1.out'});
    if (bright) {
      panel.setAttribute('data-theme','bright');
      panel.classList.add('theme-bright');
    } else {
      panel.removeAttribute('data-theme');
      panel.classList.remove('theme-bright');
    }
    if (window.gsap) gsap.to(panel, {autoAlpha:1, duration:.18, delay:.12, ease:'power1.out'});
  }

  // ---------- Format helpers ----------
  function fmtWhen(when) {
    const fmt = (d) => new Date(d).toLocaleString([], { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    if (!when) return 'Unknown';
    if (when.start && when.end) return `${fmt(when.start)} — ${fmt(when.end)}`;
    if (when.start) return `${fmt(when.start)} →`;
    if (when.end)   return `→ ${fmt(when.end)}`;
    return 'Unknown';
  }
  function isActiveNow(when) {
    const now = new Date();
    if (!when) return true;
    const s = when.start ? new Date(when.start) : null;
    const e = when.end   ? new Date(when.end)   : null;
    if (s && e) return s <= now && now <= e;
    if (s && !e) return s <= now;
    if (!s && e) return now <= e;
    return true;
  }
  function sevBadgeClass(props) {
    const txt = [
      props?.impact, props?.eventType, props?.eventSubType,
      props?.description, props?.lanes, props?.roadStatus
    ].filter(Boolean).join(' ').toLowerCase();
    if (/(full|complete)\s*clos|detour|closed\b|no access|blocked/.test(txt)) return 'bad';
    if (/(lane|shoulder|speed|reduced|stop\/?go|traffic control|contra\s*flow)/.test(txt)) return 'warn';
    return 'ok';
  }
  function distanceLabel(m) {
    if (!Number.isFinite(m)) return '';
    return (m < 950) ? `${Math.round(m/10)*10} m` : `${(m/1000).toFixed(1)} km`;
  }

  // ---------- GSAP helpers ----------
  function animateRowsIn(tbody) {
    if (!window.gsap) return;
    const rows = [...tbody.querySelectorAll('tr')];
    gsap.fromTo(rows,
      {opacity:0, y:6},
      {opacity:1, y:0, duration:.28, ease:'power1.out', stagger:.04, clearProps:'opacity,transform'}
    );
  }
  function highlightRow(tr) {
    if (!window.gsap) return;
    gsap.fromTo(tr, {backgroundColor:'transparent'}, {backgroundColor:'var(--gw-hi)', duration:.25, yoyo:true, repeat:1, ease:'power1.out'});
  }
  function animateChipNumber(el, label, toVal) {
    if (!el) return;
    const nEl = el.querySelector('.n');
    const from = Number(el.dataset.v || nEl?.textContent || 0) || 0;
    el.dataset.v = String(toVal);
    if (!window.gsap) { nEl.textContent = String(toVal); el.innerHTML = `<b>${label}</b> <span class="n">${toVal}</span>`; return; }
    const obj = {v: from};
    gsap.to(obj, {
      v: toVal, duration:.45, ease:'power1.out',
      onUpdate: () => { nEl.textContent = String(Math.round(obj.v)); },
      onComplete: () => { nEl.textContent = String(toVal); }
    });
  }
  function attachButtonRipple(btn) {
    // Simple GSAP ripple on pointerdown
    btn.addEventListener('pointerdown', (e) => {
      const rect = btn.getBoundingClientRect();
      const r = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dot = document.createElement('span');
      dot.className = 'gw-ripple';
      dot.style.left = (x - 5) + 'px';
      dot.style.top  = (y - 5) + 'px';
      btn.appendChild(dot);
      if (window.gsap) {
        gsap.fromTo(dot, {scale:0, opacity:.35}, {
          scale:(r/5), opacity:0, duration:.6, ease:'power2.out',
          onComplete:()=> dot.remove()
        });
      } else {
        dot.remove();
      }
    }, {passive:true});
  }

  // ---------- Render table + interactions ----------
  function renderDisruptionsTable(rows, summary) {
    ensureDisruptionsTableCSS();
    const panel = ensureDisruptionsPanelShell();
    applyPanelTheme(panel);
    if (window.gsap) {
      gsap.fromTo(panel, {autoAlpha:0, y:10}, {autoAlpha:1, y:0, duration:.35, ease:'power1.out'});
    }

    const tbody   = panel.querySelector('#disruptions-tbody');
    const chipTot = panel.querySelector('#dp-chip-total');
    const chipSev = panel.querySelector('#dp-chip-sev');

    //console.log('[disrupt] rows to render =', rows);

    // Fill rows
    tbody.innerHTML = rows.map(r => `
      <tr data-id="${r.id}" tabindex="0">
        <td>
          <div class="gw-loc-title">${r.title}</div>
          ${r.addr ? `<div class="gw-loc-sub">${r.addr}</div>` : ``}
        </td>
        <td><div class="gw-desc">${r.description || '—'}</div></td>
        <td><div class="gw-when">${r.when}</div></td>
        <td><span class="gw-dist-pill">${r.dist || ''}</span></td>
        <td class="gw-td-action"><button class="gw-dbtn dp-view">View on map</button></td>
      </tr>
    `).join('');

    // Animate rows
    animateRowsIn(tbody);

    // Update chips (Active-now removed)
    animateChipNumber(chipTot, 'Total nearby:', summary?.count ?? rows.length);
    if (chipSev) {
      const sevText = summary?.severity ? (summary.severity[0].toUpperCase()+summary.severity.slice(1)) : '—';
      const nEl = chipSev.querySelector('.n');
      if (window.gsap) gsap.fromTo(nEl, {opacity:0, y:-4}, {opacity:1, y:0, duration:.25, ease:'power1.out'});
      nEl.textContent = sevText;
    }

    // Delegate events
    tbody.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-id]');
      if (!tr) return;
      const id = tr.dataset.id;
      highlightRow(tr);
      if (ev.target.classList.contains('dp-view') || ev.target.closest('.dp-view')) {
        focusMarkerById(id, true);
      } else {
        focusMarkerById(id, false);
      }
    });
    tbody.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const tr = ev.target.closest('tr[data-id]');
        if (!tr) return;
        highlightRow(tr);
        focusMarkerById(tr.dataset.id, false);
      }
    });

    // Ripple on action buttons
    [...tbody.querySelectorAll('.gw-dbtn')].forEach(attachButtonRipple);

    // Follow lighting toggle (bind once)
    const btnLighting = document.getElementById('btn-lighting');
    if (!panel.dataset.listenLights) {
      panel.dataset.listenLights = '1';
      btnLighting?.addEventListener('click', () => applyPanelTheme(panel));
    }

    // Ensure visible (in case clearRoute() hid with inline style)
    panel.style.removeProperty('display');
    panel.classList.remove('d-none');
  }

  // ---------- Map focus with marker micro-animation ----------
  async function focusMarkerById(id, panOnly) {
    const marker = (window._disruptionMarkerIndex && window._disruptionMarkerIndex.get(id)) || null;
    if (!marker) return;
    const pos = marker.getPosition?.() || marker.position;
    if (!pos) return;

    // Pan & zoom
    pushView?.(snapshotView?.());
    map.panTo(pos);
    map.setZoom(Math.max(16, map.getZoom() || 16));

    // Micro "pop" for AdvancedMarker content
    if (marker.content && window.gsap) {
      gsap.fromTo(marker.content, {scale:1}, {scale:1.18, duration:.18, yoyo:true, repeat:1, transformOrigin:'250% 250%', ease:'power1.out'});
      gsap.fromTo(marker.content, {filter:'drop-shadow(0px 0px 0px rgba(0,0,0,0))'}, {filter:'drop-shadow(0px 0px 6px rgba(0,0,0,.35))', duration:.5, yoyo:true, repeat:1, ease:'power1.out'});
    }

    if (!panOnly && __DISRUPTION_IW__ && disruptionIW) {
  try {
    const card = window._disruptionCardsIndex?.get(id);
    if (card) {
      const html = renderDisruptionIW(card);
      if (html) {
        disruptionIW.setPosition(pos);
        disruptionIW.setContent(html);
        disruptionIW.open({ map });
      }
    } else {
      disruptionIW.close();
    }
  } catch(_) {}
}

  }

  // ---------- Build request ----------
  const base = '/api/disruptions/along-route';
  const urls = [
    `${base}?polyline=${encodeURIComponent(enc)}&radius_m=${radiusM}`,
    `${base}/?polyline=${encodeURIComponent(enc)}&radius_m=${radiusM}`
  ];

  // ---------- Fetch ----------
    // ---------- Fetch (with AbortController + last-write-wins) ----------
  let data = null, ok = false;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: window._disruptionsInflight.controller.signal
      });
      if (res.ok) { data = await res.json(); ok = true; break; }
    } catch (e) {
      // If aborted, user changed route; silently stop.
      if (e && e.name === 'AbortError') return;
      console.error(e);
    }
  }

  // Guard 1: your original guard (kept)
  if (reqId !== disruptionReqId) return;

  // Guard 2: drop stale responses that are not the latest in-flight anymore
  if (myReqId !== (window._disruptionsInflight?.id)) return;

  if (!ok) { disruptionSummary = null; return; }


  // ---------- Clear old markers + reset index ----------
  disruptionMarkers.forEach(m => (m.map !== undefined) ? (m.map = null) : m.setMap(null));
  disruptionMarkers = [];
  _disruptionMarkerIndex.clear();

  // ---------- Build markers ----------
  const rawFeats = Array.isArray(data?.features) ? data.features : [];
  const feats = dedupeFeatures(rawFeats);   // <<— 核心去重在這裡
  currentDisruptionFeatures = feats;

  feats.forEach((f) => {
  const p = f.properties || {};
  const id = canonDisruptionId(p);  // <<— 穩定 id

  // 已有相同 id 的 marker 就略過（避免重覆）
  if (window._disruptionMarkerIndex?.has(id)) return;

  // ...（維持你原本的求座標邏輯）
  let lat = p?.marker?.lat, lng = p?.marker?.lon;
  if (lat == null || lng == null) {
    const g = f.geometry || {};
    if (g.type === 'Point' && Array.isArray(g.coordinates)) {
      const [lo, la] = g.coordinates; lat = la; lng = lo;
    } else if (g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length) {
      const mid = g.coordinates[Math.floor(g.coordinates.length/2)];
      const [lo, la] = mid; lat = la; lng = lo;
    } else if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates[0]?.length) {
      const c = g.coordinates[0][0]; const [lo, la] = c; lat = la; lng = lo;
    }
  }
  if (lat == null || lng == null) return;

  // ...（照你原本方式建立 marker）
  let marker;
  if (google.maps.marker?.AdvancedMarkerElement) {
    const el = (() => { const d = document.createElement('div');
      d.style.cssText='width:26px;height:26px;border-radius:10px;display:grid;place-items:center;background:#fb923c;color:#111;font-size:16px;line-height:1;border:2px solid #fff;box-shadow:0 1px 0 rgba(0,0,0,.45),0 0 0 3px rgba(251,146,60,.25);user-select:none;'; d.textContent='🚧'; return d;})();
    marker = new google.maps.marker.AdvancedMarkerElement({
      map, position: { lat, lng }, content: el, title: p.title || 'Planned disruption', zIndex: 50
    });
    marker.content = el;
    marker.addListener('gmp-click', () => {
      if (__DISRUPTION_TOAST__) showToast(disruptionToastHtml(p));
      focusMarkerById(id, true);
    });
  } else {
    marker = new google.maps.Marker({
      map, position: { lat, lng }, title: p.title || 'Planned disruption', zIndex: 50,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#fb923c', fillOpacity: 1, strokeColor: '#111', strokeWeight: 1.5 }
    });
    marker.addListener('click', () => {
      if (__DISRUPTION_TOAST__) showToast(disruptionToastHtml(p));
      focusMarkerById(id, true);
    });
  }
  disruptionMarkers.push(marker);
  _disruptionMarkerIndex.set(id, marker);  // <<— 用 canonical id index
});


  // ---------- Summarise & rows ----------
  disruptionSummary = summariseDisruptions(feats);

  const rows = feats.map((f) => {
  const p = f.properties || {};
  const id = canonDisruptionId(p);
  const active = isActiveNow(p.when);
  const sevCls = sevBadgeClass(p);
  const distance_m = Number(p.distance_m);           // <<— numeric
  const dist = distanceLabel(distance_m);            // <<— display label
  const description = (p.description && String(p.description).trim()) ||
                      [p.impact, p.roadStatus, p.lanes].filter(Boolean).join(' · ');
  return {
    id,
    distance_m,                                      // <<— 保留數值
    title: p.title || p.name || 'Disruption',
    addr: p.road || p.location || '',
    active,
    sevCls,
    impact: p.impact || 'Unknown',
    roadStatus: p.roadStatus || '',
    lanes: p.lanes || '',
    when: fmtWhen(p.when),
    whenRaw: p.when || null,
    dist,
    description
  };
});


_disruptionCardsIndex.clear();

const byId = new Map();
for (const r of rows) {
  const prev = byId.get(r.id);
  if (!prev || (r.distance_m ?? Infinity) < (prev.distance_m ?? Infinity)) {
    byId.set(r.id, r);
  }
}
for (const [id, card] of byId) _disruptionCardsIndex.set(id, card);

const rowsToRender = Array.from(byId.values());
renderDisruptionsTable(rowsToRender, disruptionSummary);



  // ---------- Auto scroll first time ----------
  if (disruptionSummary && disruptionSummary.count > 0 && !window._disruptionsScrolledOnce) {
    window._disruptionsScrolledOnce = true;
    document.getElementById('disruptions-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- Utils ----------
  async function ensureGSAP() {
    if (window.gsap) return window.gsap;
    await new Promise((resolve) => {
      const id = 'gsap-cdn-script';
      if (document.getElementById(id)) return resolve();
      const sc = document.createElement('script');
      sc.id = id;
      sc.src = 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js';
      sc.async = true; sc.onload = resolve; sc.onerror = resolve;
      document.head.appendChild(sc);
    });
    return window.gsap;
  }
}






    // Start navigation button
    const btnStart = document.createElement("button");
    btnStart.id = "gw-start";
    btnStart.className = "gw-btn gw-btn-primary";
    btnStart.textContent = "Start navigation";
    btnStart.disabled = true;
    routeBar.appendChild(btnStart);

    let PREFER_SAFER_ROUTING = true;

   async function routeNow(){
  const origin = originLatLng ? originLatLng : originInput?.value.trim();
  const dest   = destLatLng   ? destLatLng   : destInput?.value.trim();
  if (!origin || !dest) { showToast('Enter both start and destination'); return; }

  btnRoute.disabled = true;
  btnRoute.textContent = 'Routing…';

    // ---- Immediately hide stale score and cancel previous scoring request ----
  try { _scoreAbort?.abort(); } catch (_) {}
  setScoringBusyUI();          // shows "Safety: checking…" and removes the stale number
  // setRouteWaiting();        // optional here; you already call it after drawing the new path
  // cancel previous compare fetches & hide the drawer instantly
  try { window._compareInflight?.controller?.abort(); } catch(_){}
  preflightCompareUI('load');      // or 'load' if you prefer skeleton over hidden
  toggleCompare(true);

  window.__clearPrefDecorations?.();

  directionsSvc.route(
    {
      origin,
      destination: dest,
      travelMode: google.maps.TravelMode.WALKING,
      provideRouteAlternatives: PREFER_SAFER_ROUTING
    },
    async (res, status) => {
      btnRoute.disabled = false;
      btnRoute.textContent = 'Route';

      if (status !== google.maps.DirectionsStatus.OK || !res) {
        showToast('Could not compute route');
        // keep user marker visible if routing failed
        setRoutePresence(false);
        return;
      }

      // draw
      lastDirectionsResult = res;
      const chosen = res.routes[0];
      directionsRndr.setDirections(res);

      const path = chosen.overview_path || res.routes[0].overview_path || [];
      routeHalo.setPath(path);
      routeHalo.setOptions({ strokeOpacity: 0.75 });
      routePolyline.setPath(path);
      routePolyline.setOptions({ strokeOpacity: 1 });
      setRouteWaiting();

      const b = new google.maps.LatLngBounds();
      path.forEach(p => b.extend(p));
      map.fitBounds(b);

      // start button
      const leg = (chosen.legs && chosen.legs[0]) || res.routes[0].legs[0];
      btnStart.disabled = false;
      btnStart.onclick = () => openExternalNav(path, leg.start_location, leg.end_location);

      // color (or keep default)
      await scoreAndColorRoute(res);

      // Hide the pink "you" marker + pause geolocation while a route is active
      setRoutePresence(true);

      // optional nearby refresh
      if (state.venues) { lastQuery = null; maybeSearch(); }

      // disruptions near route
      const myId = ++disruptionReqId;
      await fetchAndRenderDisruptions(res, 200, myId, false);
      // === Build candidates (safer/shorter) from Google routes and apply preference ===
try{
  const routes = (res.routes || []).slice(0,3).map((r, idx) => {
    const leg = r.legs?.[0];
    const path = r.overview_path || [];
    const encoded = getEncodedPolyline({ routes:[r] }) || getEncodedPolyline(res) || '';
    const distanceText = leg?.distance?.text || '';
    const durationText = leg?.duration?.text || '';
    const heur = heuristicScoreFromFrontend(path); // your quick frontend heuristic
    return { key:`r${idx}`, path, encoded, distanceText, durationText, score: heur.overall, label: heur.label };
  });

  if (!routes.length) return;

  // shorter = shortest distance, safer = highest score
  const byDistAsc   = [...routes].sort((a,b)=> (parseFloat(a.distanceText)||1e9) - (parseFloat(b.distanceText)||1e9));
  const byScoreDesc = [...routes].sort((a,b)=> (b.score||0) - (a.score||0));

  const shorter = { ...byDistAsc[0],   kind:'Shorter', key:'shorter' };
  const safer   = { ...byScoreDesc[0], kind:'Safer',   key:'safer'   };

  // Optionally refine scores from backend, then apply preference
  (() => {
  // Bump compare request id and cancel the previous one
  const cmp = (window._compareInflight ||= { id: 0, controller: null });
  cmp.id += 1;
  const myId = cmp.id;
  try { cmp.controller?.abort(); } catch(_){}
  cmp.controller = new AbortController();

  // Put drawer into loading immediately (skeleton or hidden)
  preflightCompareUI('load'); // or 'hide'

  (async () => {
    try {
      const body = { polylines: [safer.encoded, shorter.encoded], when:'night', minutes:60 };
      const resp = await fetch('/api/route/score', {
        method:'POST',
        headers:{'Accept':'application/json','Content-Type':'application/json'},
        credentials:'same-origin',
        body: JSON.stringify(body),
        signal: cmp.controller.signal        // ← cancellation
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      // Drop stale response if user already changed route
      if (myId !== (window._compareInflight?.id)) return;

      const arr = json?.routes || [];
      if (arr[0]) { safer.score = arr[0].overall ?? safer.score; safer.label = arr[0].label || safer.label; }
      if (arr[1]) { shorter.score = arr[1].overall ?? shorter.score; shorter.label = arr[1].label || shorter.label; }

    } catch (e) {
      // If aborted because of route change, just exit quietly
      if (e?.name === 'AbortError') return;
      console.warn('compare scoring failed:', e);
    }

    // Still latest? render and reveal
    if (myId === (window._compareInflight?.id)) {
      window.__applyPrefForRoutes?.({ safer, shorter });
      revealCompareUI(); // show the new drawer
    }
  })();
})();


}catch(e){ console.warn('candidate build failed', e); }

    }
  );
}

let _routeColorLabel = 'waiting';        // default optimistic color on first draw
let _recolorSeq = 0;                    // increments per scoring attempt
let _scoreAbort = null; 


// ---- Traffic-light scoring & coloring ----
const TL_COLORS = {
  green:  '#16a34a',
  yellow: '#f59e0b', 
  red:    '#ef4444'
};

function hashStr(s){
  let h = 5381, i = s.length;
  while (i) h = (h * 33) ^ s.charCodeAt(--i);
  return (h >>> 0).toString(36);
}

function cacheSetRouteLabel(polyline, label){
  try {
    const key = 'routeScoreCache';
    const obj = JSON.parse(sessionStorage.getItem(key) || '{}');
    obj[hashStr(polyline)] = { l: label, t: Date.now() };
    // prune ~200 entries
    const keys = Object.keys(obj);
    if (keys.length > 220) {
      keys.sort((a,b)=> (obj[b].t - obj[a].t));
      for (const k of keys.slice(200)) delete obj[k];
    }
    sessionStorage.setItem(key, JSON.stringify(obj));
  } catch {}
}


function cacheGetRouteLabel(polyline, maxAgeMs = 7*24*3600_000){ // 7 days
  try {
    const obj = JSON.parse(sessionStorage.getItem('routeScoreCache') || '{}');
    const rec = obj[hashStr(polyline)];
    if (rec && (Date.now() - (rec.t||0)) < maxAgeMs) return rec.l;
  } catch {}
  return null;
}

function heuristicLabelForPath(path){
  // 1) lighting coverage: count how many vertices lie within ~25m of any lit segment we already drew
  const segs = window.__lightingSegments || [];
  let litHits = 0, N = Math.max(1, path.getLength ? path.getLength() : path.length);
  const sampleStep = Math.max(1, Math.floor(N / 48)); // ~≤50 checks
  for (let i=0; i<N; i+=sampleStep){
    const p = path.getAt ? path.getAt(i) : path[i];
    const lat = (typeof p.lat === 'function') ? p.lat() : p.lat;
    const lng = (typeof p.lng === 'function') ? p.lng() : p.lng;
    let near = false;
    for (const pl of segs){
      // cheap distance to polyline in px space via Google API (fast enough)
      const d = google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(lat, lng),
        pl.getPath().getAt ? pl.getPath().getAt( Math.min(pl.getPath().getLength()-1, 0) ) : new google.maps.LatLng(lat, lng)
      );
      // We don't have per-vertex distance; approximate: if we're within ~30m of *any* segment, count it
      if (d <= 30) { near = true; break; }
    }
    if (near) litHits++;
  }
  const litCov = litHits / Math.max(1, Math.ceil(N / sampleStep));

  // 2) venues density along path (very rough)
  const vm = (window.venueMarkers || []);
  let closeVenues = 0;
  if (vm.length && N > 1){
    const a = path.getAt ? path.getAt(0) : path[0];
    const b = path.getAt ? path.getAt(N-1) : path[N-1];
    const A = new google.maps.LatLng((typeof a.lat==='function')?a.lat():a.lat, (typeof a.lng==='function')?a.lng():a.lng);
    const B = new google.maps.LatLng((typeof b.lat==='function')?b.lat():b.lat, (typeof b.lng==='function')?b.lng():b.lng);
    // quick bounding box filter
    const bounds = new google.maps.LatLngBounds(); bounds.extend(A); bounds.extend(B);
    vm.forEach(m=>{
      const pos = m.getPosition?.() || m.position;
      if (!pos) return;
      if (bounds.contains(pos)) {
        const d = google.maps.geometry.spherical.computeDistanceBetween(pos, A); // roughly relative to start
        if (d <= 600) closeVenues++;
      }
    });
  }
  // 3) disruptions snapshot (if already loaded)
  const feats = (window.currentDisruptionFeatures || []);
  let nearDisrupt = 0;
  if (feats.length){
    const midIdx = Math.floor(N/2);
    const mid = path.getAt ? path.getAt(midIdx) : path[midIdx];
    const C = new google.maps.LatLng(
      (typeof mid.lat==='function')?mid.lat():mid.lat,
      (typeof mid.lng==='function')?mid.lng():mid.lng
    );
    const STEP = feats.length > 200 ? Math.ceil(feats.length/200) : 1;
    for (let i=0;i<feats.length;i+=STEP){
      const f = feats[i];
      const m = f?.properties?.marker;
      if (m && m.lat!=null && m.lon!=null){
        const d = google.maps.geometry.spherical.computeDistanceBetween(C, new google.maps.LatLng(m.lat, m.lon));
        if (d <= 200) nearDisrupt++;
      }
    }
  }


  // quick weighted sum → bucket
  // lighting (0.5), venues (0.3), disruptions penalty (0.4)
  const score =
    0.5 * Math.min(1, litCov) +
    0.3 * Math.min(1, closeVenues / 6) -
    0.4 * Math.min(1, nearDisrupt / 3);
  if (score >= 0.66) return 'green';
  if (score >= 0.33) return 'yellow';
  return 'red';
}





function setScoringBusyUI() {
  const pill = document.getElementById('gw-score-pill');
  if (!pill) return;

  pill.style.display = 'inline-flex';
  pill.style.background = '#111827';
  pill.style.color = '#e5e7eb';
  pill.style.borderRadius = '999px';
  pill.style.padding = '.45rem .7rem';
  pill.style.fontWeight = '800';
  pill.style.gap = '.5rem';


  const textSpan = ensurePillTextNode();
  if (textSpan) textSpan.textContent = 'Safety: checking…';



  if (!pill.querySelector('.gw-dot')) {
    const dot = document.createElement('span');
    dot.className = 'gw-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = '•';
    pill.appendChild(dot);
  }

  if (!document.getElementById('gw-pill-css')) {
    const s = document.createElement('style');
    s.id = 'gw-pill-css';
    s.textContent = `
      #gw-score-pill .gw-step{opacity:.4}
      #gw-score-pill .done{opacity:1}
      #gw-score-pill .gw-dot{animation: gwPulse 1.2s ease-in-out infinite}
      @keyframes gwPulse{0%{opacity:.35} 50%{opacity:1} 100%{opacity:.35}}
    `;
    document.head.appendChild(s);
  }
}

function markStepDone(id){
  const el = document.getElementById(id);
  if (el) el.classList.add('done');
}

function setRouteColorInstant(label){
  const color = TL_COLORS[label] || '#f59e0b';
  routePolyline.setOptions({ strokeColor: color, strokeOpacity: 0.98, strokeWeight: 7 });
  routeHalo.setOptions({ strokeColor: '#ffffff', strokeOpacity: 0.75, strokeWeight: 10 });
  _routeColorLabel = label;
}

function crossfadeRouteColor(toLabel, ms=120){
  const from = TL_COLORS[_routeColorLabel] || '#f59e0b';
  const to   = TL_COLORS[toLabel] || from;
  if (from === to) return;
  const overlay = new google.maps.Polyline({
    map, path: routePolyline.getPath(), strokeColor: to, strokeOpacity: 0, strokeWeight: 7, zIndex: 31, clickable: false
  });
  const t0 = performance.now();
  const step = (t)=>{
    const p = Math.min(1, (t - t0)/ms);
    routePolyline.setOptions({ strokeOpacity: 0.98*(1-p) });
    overlay.setOptions({ strokeOpacity: 0.98*p });
    if (p < 1) requestAnimationFrame(step);
    else { routePolyline.setOptions({ strokeColor: to, strokeOpacity: 0.98 }); overlay.setMap(null); _routeColorLabel = toLabel; }
  };
  requestAnimationFrame(step);
}


// Update the pill + toast with final numbers (no flicker)
function updateScoreUIStable(payload, finalLabel) {
  const pct = Math.round((payload?.overall ?? 0) * 100);
  const color = TL_COLORS[finalLabel] || '#64748b';
  const pill = document.getElementById('gw-score-pill');
  const toast = document.getElementById('gw-score-toast');

  if (pill) {
    const span = ensurePillTextNode();
    if (span) {
      span.textContent = `Safety Score: ${finalLabel.toUpperCase()} • ${pct}%`;
    }
    pill.style.background = color;
    pill.style.color = '#111';
    pill.style.display = 'inline-flex';      
    pill.style.borderRadius = '999px';       
    pill.style.padding = '.4rem .7rem';      
    pill.style.fontWeight = '800';          
    pill.setAttribute('aria-expanded', 'false');
  }

}

/*
  if (pill) {
    pill.style.display = 'inline-flex';
    pill.style.background = color;
    pill.style.color = '#111';
    pill.style.borderRadius = '999px';
    pill.style.padding = '.4rem .7rem';
    pill.style.fontWeight = '800';
    pill.textContent = `Safety Score: ${finalLabel.toUpperCase()} • ${pct}%`;
  }

}
*/
const WAIT_COLOR = '#0b0f18';  // near-black
const WAIT_HALO  = '#ffffff';

// 2) call this immediately after drawing a new path (before score request):
function setRouteWaiting() {
  routePolyline.setOptions({
    strokeColor: WAIT_COLOR, strokeOpacity: 0.9, strokeWeight: 7
  });
  routeHalo.setOptions({
    strokeColor: WAIT_HALO, strokeOpacity: 0.55, strokeWeight: 10
  });
  _routeColorLabel = 'waiting';
}





async function scoreAndColorRoute(directionsResult) {
  if (!USE_ROUTE_SCORE) return;

  const enc = getEncodedPolyline(directionsResult);
  if (!enc) return;

  // 0) Choose an immediate label from cache OR heuristic
  const path = (directionsResult?.routes?.[0]?.overview_path) || [];
  const cached = cacheGetRouteLabel(enc);

  // Always define `instant` (what we colored immediately)
  // Prefer cache; otherwise fall back to your current route color or a heuristic.
  let instant = null;
  if (cached) {
    instant = cached;
    setRouteColorInstant(cached);
  } else {
   
    instant = _routeColorLabel ?? null; // best-effort fallback to current label if you track one
  }

  // 1) mark UI busy, but keep the instant color
  setScoringBusyUI();

  // 2) fire server request with timeout + cancellation
  try { _scoreAbort?.abort(); } catch {}
  const mySeq = ++_recolorSeq;
  _scoreAbort = new AbortController();

  // timebox: if response > 600ms and bucket equals instant, skip repaint
  const HARD_BUDGET_MS = 600;
  const startT = performance.now();

  try {
    const res = await fetch('/api/route/score', {
      method: 'POST',
      headers: { 'Accept':'application/json','Content-Type':'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ polylines:[enc], when:'night', minutes:60 }),
      signal: _scoreAbort.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (mySeq !== _recolorSeq) return;

    const r = Array.isArray(json?.routes) ? json.routes[0] : json;

    // Use nullish coalescing; avoid falsy '' choosing `instant` by mistake
    const finalLabel = (r?.label ?? instant);

    // Cache the final label
    if (finalLabel) cacheSetRouteLabel(enc, finalLabel);

    const elapsed = performance.now() - startT;

    // Safe same-bucket check even if `instant` is null
    const sameBucket = (finalLabel != null && instant != null && finalLabel === instant);

    if (sameBucket) {
      // Buckets match -> only update numbers/percentages; color already correct.
      const currentLabel = _routeColorLabel ?? instant ?? finalLabel;
      updateScoreUIStable(r, currentLabel);
    } else {
      // Buckets differ → make the line match whatever the pill will say.
      const animMs = (elapsed > HARD_BUDGET_MS) ? 0 : 120;
      if (finalLabel) {
        if (animMs === 0) {
          setRouteColorInstant(finalLabel);
        } else {
          crossfadeRouteColor(finalLabel, animMs);
        }
      }
      updateScoreUIStable(r, finalLabel ?? instant);
    }

  } catch (e) {
    if (e?.name === 'AbortError') return; // superseded
    // keep instant color; just mark UI as N/A
    const pill = document.getElementById('gw-score-pill');
    if (pill){ pill.style.display='inline-flex'; pill.style.background='#6b7280'; pill.style.color='#fff'; pill.textContent='Safety: N/A'; }
    const toast = document.getElementById('gw-score-toast');
    if (toast){ toast.style.display='block'; toast.textContent='Could not score this route.'; }
    console.warn('scoreAndColorRoute (instant-first) failed:', e);
  }
}



// Normalize whatever the scorer returns into {overall[0..1], label, components:{}}
function normalizeScorePayload(data){
  if (!data) return { overall: 0, label: 'red', components:{} };
  // accept {overall,label,components} or {footfall:{overall,label,components}}
  const p = data.footfall || data;
  const overall = Number(p.overall ?? p.score ?? p.value ?? 0);
  const label = p.label || (overall >= .66 ? 'green' : overall >= .33 ? 'yellow' : 'red');
  const components = p.components || {
    lighting:     { score: p.lighting ?? 0 },
    footfall:     { score: p.footfall ?? 0 },
    venues:       { score: p.venues ?? 0 },
    disruptions:  { penalty: p.disruptions ?? 0 }
  };
  return { overall, label, components };
}

async function fetchRouteScore(enc, minutes = 60, when = 'night') {
  const url = '/api/route/score';               // keep without trailing slash if that’s your route
  const payload = { polylines: [enc], when, minutes };

  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  // Surface server error text once for debugging
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`score ${res.status}: ${txt || 'unknown error'}`);
  }
  return res.json();
}



function heuristicScoreFromFrontend(path){
  // lighting coverage
  const segs = (window.__lightingSegments || []);
  const nearLit = (pt) => segs.some(pl => {
    try{
      const dist = google.maps.geometry.spherical.computeDistanceBetween(
        pt, pl.GetPointAtDistance ? pl.GetPointAtDistance(0) : pl.getPath().getAt?.(0) || pt
      );
      return dist < 40; // within 40 m of any lit segment sample (cheap proxy)
    }catch{ return false; }
  });
  const samples = (path || []).filter((_,i)=> i%5===0); // sample every ~5th vertex
  const litFrac = samples.length ? samples.filter(nearLit).length / samples.length : 0;

  // venue density within 100m per km of route
  let venueHits = 0;
  const venues = Array.from((window.venueIndex || new Map()).values());
  const nearVenue = (pt) => venues.some(v => {
    try{
      const pos = v.marker.getPosition?.() || v.marker.position;
      return pos && google.maps.geometry.spherical.computeDistanceBetween(pt,pos) < 100;
    }catch{ return false; }
  });
  samples.forEach(pt => { if (nearVenue(pt)) venueHits++; });
  const km = (()=> {
    try{
      let d=0; for (let i=1;i<path.length;i++){
        d += google.maps.geometry.spherical.computeDistanceBetween(path[i-1], path[i]);
      }
      return d/1000;
    }catch{ return 1; }
  })();
  const venuePerKm = km>0 ? (venueHits / Math.max(1, samples.length)) * (samples.length/km) : 0;
  const venueScore = Math.min(1, venuePerKm / 6); // saturate around ~6 venues/km within 100 m

  // disruptions penalty from last summary (if any)
  const sev = (window.disruptionSummary && window.disruptionSummary.severity) || 'low';
  const penalty = ({ none:0.00, low:0.10, medium:0.25, high:0.45 }[sev] || 0.10);

  // Weighted blend
  const overall = Math.max(0, (0.5*litFrac + 0.3*venueScore + 0.2*(1-penalty)));
  const label = overall >= .66 ? 'green' : overall >= .33 ? 'yellow' : 'red';
  return { overall, label, components: {
    lighting:{score: litFrac}, venues:{score: venueScore}, disruptions:{penalty}
  }};
}




  // 4-B) clearRoute — make panel hide safely and recover on next render; reset chips that still exist
function clearRoute() {
  // Original map/route clears
  directionsRndr.set('directions', null);
  routePolyline.setPath([]);
  routeHalo.setPath([]);
  routePolyline.setOptions({ strokeOpacity: 0 });
  routeHalo.setOptions({ strokeOpacity: 0 });
  _routeColorLabel = 'waiting';


  // scorePill.style.display = 'none';
  // hideScoreToast();
  const pillEl = document.getElementById('gw-score-pill');
  if (pillEl) {
    pillEl.style.display = 'none';
    pillEl.setAttribute('aria-expanded', 'false');
  }
  hideCompare();

  hideCompare();
  btnStart.disabled = true;

  // Clear inputs + internal state
  if (originInput) originInput.value = '';
  if (destInput)   destInput.value   = '';
  originLatLng = null;
  destLatLng   = null;
  updateRouteCta?.();

  lastDirectionsResult = null;
  disruptionIW.close?.();
  disruptionMarkers.forEach(m => (m.map !== undefined) ? (m.map = null) : m.setMap(null));
  disruptionMarkers = [];
  updateMapPadding?.();
  setRoutePresence?.(false);

  // Hide and reset the panel contents (use inline display to avoid class conflicts)
  const dp = document.getElementById('disruptions-panel');
  if (dp) {
    dp.style.display = 'none';                // ensures it can be restored via style.removeProperty('display')
    dp.classList.remove('d-none');            // avoid getting stuck if a CSS .d-none uses !important
    const T  = dp.querySelector('#disruptions-tbody'); if (T) T.innerHTML = '';
    const CT = dp.querySelector('#dp-chip-total');     if (CT) { const n = CT.querySelector('.n'); if (n) n.textContent = '0'; }
    const CS = dp.querySelector('#dp-chip-sev');       if (CS) { const n = CS.querySelector('.n'); if (n) n.textContent = '—'; }
  }

  // Reset indexes so stale ids can't focus markers
  (window._disruptionMarkerIndex && window._disruptionMarkerIndex.clear());
  (window._disruptionCardsIndex && window._disruptionCardsIndex.clear());
  window._disruptionsScrolledOnce = false;
  window.__wwi_lastCandidates = null;
  window.__clearPrefDecorations?.();
}

function getCsrfFromCookie(name='csrftoken'){
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}





    routePolyline.addListener('click', async (e) => {
      const clickAt = e?.latLng || map.getCenter();

      // show skeleton immediately
      openDisruptionSkeletonAt(clickAt);

      // show cached summary right away (prefetched in routeNow), then refresh below
      if (disruptionSummary) {
        const sev   = disruptionSummary.severity;
        const color = ({ none:'#16a34a', low:'#f59e0b', medium:'#fb923c', high:'#ef4444' }[sev]) || '#64748b';
        const title = ({ none:'No disruptions', low:'Minor disruption(s)', medium:'Lane/speed impacts', high:'Major closure or detour' }[sev]);
        const msg   = ({ none:'No planned disruptions along this route.',
                        low:'Minor disruptions along this route.',
                        medium:'Lane or speed restrictions along this route.',
                        high:'Major closure or detour along this route.' }[sev]);

        disruptionIW.setPosition(clickAt);
        disruptionIW.setContent(
          `<div style="font:500 14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:.75rem .85rem; color:#111; background:${color}; border-radius:12px;">
            <div style="font-weight:800; margin:0 0 .35rem 0">${title}</div>
            <div>${msg}</div>
            <div class="small" style="opacity:.85;margin-top:.35rem">
              ${disruptionSummary.activeNow} active now, ${disruptionSummary.count} total nearby.
            </div>
          </div>`
        );
        disruptionIW.open({ map });
      }

      // fetch fresh data and replace skeleton/cached content when it arrives
      if (lastDirectionsResult) {
        const myId = ++disruptionReqId;
        await fetchAndRenderDisruptions(lastDirectionsResult, 200, myId, clickAt); // <-- pass clickAt (not null)
      }
    });



    // Buttons
    btnRoute?.addEventListener('click', routeNow);
    btnClear?.addEventListener('click', clearRoute);

    [originInput, destInput].forEach(inp=>inp?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); routeNow(); } }));
    btnRoute?.addEventListener('contextmenu', e=>e.preventDefault());

    btnRoute?.addEventListener('mousedown', (e) => {

      if ((e.ctrlKey || e.metaKey) && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude: lat, longitude: lng } = pos.coords || {};
            const ll = new google.maps.LatLng(lat, lng);

            if (isInsideCity(ll)) {
              goTo({ lat, lng }, 'My location');
              startLiveYou?.();    
            }
            else { goToMelbourneCentral('You’re outside the City of Melbourne, will use Melbourne Central as the default start point'); }
          },
          () => goToMelbourneCentral('You are currently outside of City of Melbourne, will use Melbourne Central as the default start point'),
          { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
        );
      }
    });

      btnLighting?.addEventListener('click', async ()=>{
      state.lighting = !state.lighting;
      syncButtonsFromState();


      // --- Sync prefbar theme with the "Street lighting" toggle ---
const prefbarEl = document.getElementById('wwi-prefbar');

// Toggle `.is-night` on the prefbar based on current lighting state.
// This only flips a CSS class; it won't affect your existing logic.
function syncPrefbarTheme() {
  if (!prefbarEl) return;
  prefbarEl.classList.toggle('is-night', !!state.lighting);
}

// Run once (initial render), and then on each lighting toggle click.
syncPrefbarTheme();
btnLighting?.addEventListener('click', syncPrefbarTheme);


      // add this line:
      setNightMode(state.lighting);

      if (state.lighting) {
        await ensureCityLighting();
        lightingLayer?.setVisible(true);
      } else {
        lightingLayer?.setVisible(false);
      }
    });

    btnVenues?.addEventListener('click', ()=>{
  state.venues = !state.venues;
  syncButtonsFromState();
  setNightMode(state.lighting);

  if (state.venues) {
    // show markers/list again
    lastQuery = null;
    maybeSearch();
  } else {
    // clear markers/list but keep panel visible
    clearVenues();
  }
  // panel is always visible
  setVenuePanelVisible(true);
});


    // Safety utilities (assessment integration)
    function showSafetyUtilities(payload) {
      let panel = document.getElementById('gw-safety-utils');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'gw-safety-utils';
        panel.style.cssText = `
          position:absolute; right:14px; bottom:14px; z-index:10000; pointer-events:auto;
          background:rgba(8,12,20,.9); color:#fff; border-radius:12px; padding:.6rem .7rem;
          border:1px solid rgba(255,255,255,.08); box-shadow:0 10px 24px rgba(0,0,0,.35);
          font:600 13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; max-width:90vw;
        `;
        panel.innerHTML = `<button id="gw-util-close" title="Hide" style="margin-left:auto;background:transparent;border:0;color:#fff;opacity:.7;cursor:pointer">✕</button><div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center"></div>`;
        mapEl.appendChild(panel);
        panel.querySelector('#gw-util-close').addEventListener('click', ()=> panel.style.display='none');
      }
      const strip = panel.querySelector('div'); strip.innerHTML = '';
      const makeBtn = (label, onclick) => { const b = document.createElement('button'); b.style.cssText = 'background:#ffd166;color:#111;border:0;border-radius:10px;padding:.35rem .6rem;font-weight:800;cursor:pointer'; b.textContent = label; b.addEventListener('click', onclick); return b; };
      if (payload?.sos)   strip.appendChild(makeBtn('SOS', ()=> location.href='tel:000'));
      if (payload?.share) strip.appendChild(makeBtn('Share my location', ()=>{
        if (navigator.clipboard && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(pos=>{
            const url = `https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
            navigator.clipboard.writeText(url);
            showToast('Location link copied. Send it to your buddy.');
          });
        } else { showToast('Copy this page link and send to your buddy.'); }
      }));
      if (payload?.timer) strip.appendChild(makeBtn('5-min check-in', ()=>{ showToast('Check-in set for 5 minutes'); setTimeout(()=> alert('Time to check-in!'), 5*60*1000); }));
      panel.style.display = strip.children.length ? 'flex' : 'none';
    }

    window.applyPlanToMap = function(actions) {
      actions.forEach(a => {
        if (a.type === 'route') {
          PREFER_SAFER_ROUTING = !!(a.payload?.preferLit || a.payload?.preferMainRoads || a.payload?.avoidAlleys);
          if (PREFER_SAFER_ROUTING) { ensureCityLighting(); state.lighting = true; syncButtonsFromState(); }
        } else if (a.type === 'layer' && a.payload?.layer === 'safeVenues') {
          state.venues = !!a.payload.visible; syncButtonsFromState();
          if (state.venues) { setVenuePanelVisible(true); lastQuery = null; maybeSearch(); }
          else { clearVenues(); setVenuePanelVisible(false); }
        } else if (a.type === 'utility') {
          showSafetyUtilities(a.payload);
        }
      });
    };

    if (Array.isArray(window.__pendingPlanActions)) {
      window.__pendingPlanActions.forEach(actions => window.applyPlanToMap(actions));
      window.__pendingPlanActions = [];
    }
  };

