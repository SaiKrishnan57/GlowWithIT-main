// safety-qi.js — Safety Quality Index (AQI-style chip for Google Maps)
// Mode: +1 Lighting nearby (<=50m), +1 Venue open NOW within 300m, +1 CCTV nearby (<=120m)
// Requires: Google Maps JS API (geometry lib).
// Data hooks (global, optional):
//   window.__lightingSegments : google.maps.Polyline[]
//   window.__venuesOpenNow    : Array<{coordinates:[lat,lng], isOpenNow:true}>
//   window.__venues24x7       : Array<{coordinates:[lat,lng], isOpen24Hours:true}>  // fallback
//   window.__cctvPoints       : Array<{lat:number,lng:number}>
//
// Public API:
//   const sqi = GlowSQI.attachSQI(map, { listenToButtons: ['btn-lighting','btn-venues'] });
//   sqi.updateAt({lat,lng})   // score a specific point
//   sqi.updateCenter()        // score map center

(function (global) {
  function toGLLatLng(google, ll) {
    return new google.maps.LatLng(ll.lat, ll.lng);
  }

  // weights (sum = 3.0)
const WEIGHTS = { lighting: 1, openNow: 1, cctv: 0.3 };
const MAX_SQI = 2.0;

function classifyWeighted(total){
  const pct = (total / MAX_SQI) * 100;
  if (pct >= 70) return { cls: 'support-strong', label: 'Strong cues' };
  if (pct >= 40) return { cls: 'support-some',   label: 'Some cues' };
  return            { cls: 'support-few',    label: 'Fewer cues' };
}

  function buildChip() {
    const wrap = document.createElement("div");
    wrap.style.position = "relative";

    const chip = document.createElement("div");
    chip.className = "gw-sqi med"; // default
    chip.innerHTML = [
      '<span class="sqi-dot"></span>',
      '<span class="sqi-score" id="sqiScore">2/3</span>',
      '<span class="sqi-divider"></span>',
      '<span class="sqi-sub" id="sqiLabel">Moderate</span>',
    ].join("");
    wrap.appendChild(chip);

    const pop = document.createElement("div");
    pop.className = "gw-sqi-pop";
    pop.style.display = "none";
    pop.innerHTML = [
      "<h6>Safety Quality Index</h6>",
      '<div class="row"><span class="k">Lighting nearby</span><span class="v" id="sqiLight">—</span></div>',
      '<div class="row"><span class="k">Venue open now ≤ 300 m</span><span class="v" id="sqiOpenNow">—</span></div>',
      '<div class="row" style="margin-top:.35rem; border-top:1px solid rgba(255,255,255,.12); padding-top:.35rem;">',
      "</div>",
    ].join("");
    wrap.appendChild(pop);

    chip.addEventListener("mouseenter", () => (pop.style.display = "block"));
    wrap.addEventListener("mouseleave", () => (pop.style.display = "none"));

    return { wrap, chip };
  }

  // ===== Scoring helpers =====
  function scoreLightingAt(google, map, point) {
    // Respect lighting toggle — if off, treat as absent
    const lightingToggleOn = document
      .getElementById("btn-lighting")
      ?.classList.contains("on");
    if (!lightingToggleOn) return 0;

    const segs = Array.isArray(global.__lightingSegments)
      ? global.__lightingSegments
      : [];
    if (segs.length && google.maps.geometry?.spherical) {
      const P = toGLLatLng(google, point);
      let min = Infinity;
      for (const seg of segs) {
        const path = seg.getPath?.();
        if (!path || !path.getLength) continue;
        // Sample vertices; your lighting geometry is dense enough for this approximation
        for (let i = 0; i < path.getLength(); i++) {
          const A = path.getAt(i);
          const d = google.maps.geometry.spherical.computeDistanceBetween(P, A);
          if (d < min) min = d;
        }
      }
      return min <= 50 ? 1 : 0; // 50 m buffer
    }
    // Fallback heuristic when no geometry wired
    return map.getZoom() >= 15 ? 1 : 0;
  }

  // Score +1 if any venue OPEN NOW within 300m of the point.
  // Falls back to 24/7 list if __venuesOpenNow is missing/empty.
  function scoreOpenNowAt(google, map, point) {

    // NEW: if the sidebar says there's an open venue within 300 m, trust it
    if (window.__domVenueOpenNowWithin300 === true) return 1;
    const P = toGLLatLng(google, point);
    const hasGeom = !!google.maps.geometry?.spherical;

    // Prefer open-now list
    const openNow = Array.isArray(global.__venuesOpenNow)
      ? global.__venuesOpenNow
      : null;
    if (openNow && openNow.length && hasGeom) {
      for (const v of openNow) {
        const [lat, lng] = v.coordinates || [];
        if (lat == null || lng == null) continue;
        const V = new google.maps.LatLng(lat, lng);
        const d = google.maps.geometry.spherical.computeDistanceBetween(P, V);
        if (d <= 300) return 1;
      }
      return 0;
    }

    // Fallback to 24/7 if available
    const always = Array.isArray(global.__venues24x7)
      ? global.__venues24x7
      : [];
    if (always.length && hasGeom) {
      for (const v of always) {
        const [lat, lng] = v.coordinates || [];
        if (lat == null || lng == null) continue;
        const V = new google.maps.LatLng(lat, lng);
        const d = google.maps.geometry.spherical.computeDistanceBetween(P, V);
        if (d <= 300) return 1;
      }
      return 0;
    }

    // No data to evaluate
    return 0;
  }


  function makeUpdater(google, map, chipEl){
  return function updateSQI(referencePoint){
    const light =  !!scoreLightingAt(google, map, referencePoint);
    const openN =  !!scoreOpenNowAt(google, map, referencePoint);

    const total = (light ? WEIGHTS.lighting : 0)
                + (openN ? WEIGHTS.openNow  : 0);

    const {cls, label} = classifyWeighted(total);
    chipEl.classList.remove('support-strong','support-some','support-few');
    chipEl.classList.add(cls);

    chipEl.querySelector('#sqiScore').textContent = `${total.toFixed(1)}/${MAX_SQI}`;
    chipEl.querySelector('#sqiLabel').textContent = label;

    const $ = s => chipEl.parentElement.querySelector(s);
    $('#sqiLight').textContent   = light ? 'Yes' : 'No';
    $('#sqiOpenNow').textContent = openN ? 'Yes' : 'No';
    
  };
}

  // Public API: attachSQI(map, {listenToButtons: ['btn-lighting','btn-venues']})
  function attachSQI(map, opts = {}) {
    if (!global.google || !global.google.maps) {
      console.error("[SQI] Google Maps not loaded.");
      return;
    }
    const { wrap, chip } = buildChip();
    map.controls[google.maps.ControlPosition.TOP_RIGHT].push(wrap);

    const update = makeUpdater(google, map, chip);
    const centerPoint = () => ({
      lat: map.getCenter().lat(),
      lng: map.getCenter().lng(),
    });

    // initial + reactive
    update(centerPoint());
    map.addListener("idle", () => update(centerPoint()));

    (opts.listenToButtons || []).forEach((id) => {
      document
        .getElementById(id)
        ?.addEventListener("click", () => update(centerPoint()));
    });

    // expose manual update (e.g., when user location or open/close state changes)
    return {
      updateAt: (latLng) => update(latLng),
      updateCenter: () => update(centerPoint()),
    };
  }

  // UMD-lite
  global.GlowSQI = { attachSQI };
})(window);