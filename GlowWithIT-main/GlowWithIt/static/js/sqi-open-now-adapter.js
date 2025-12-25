// sqi-open-now-adapter.js
// Auto-builds window.__venuesOpenNow from your existing venueIndex without changing your current code.
// Include AFTER your map/venue code and BEFORE/after safety-qi.js (order doesn't matter much).

(function () {
  function computeIsOpenNow(rec) {
    const place = rec?.place;
    const hours = rec?.hours;
    const details = rec?.details;

    if (hours && typeof hours.isOpenNow === "boolean") return hours.isOpenNow;
    // Heuristic: your UI badge sets {label:'Open now'} when NearbySearch used with openNow:true
    if (hours && typeof hours.label === "string" && /open\s*now/i.test(hours.label)) return true;
    // Heuristic: 24/7 badge means open at any time
    if (hours && typeof hours.label === "string" && /24\s*\/\s*7|24\s*hours/i.test(hours.label)) return true;

    try {
      if (
        details?.opening_hours?.isOpen &&
        typeof details.opening_hours.isOpen === "function"
      ) {
        return !!details.opening_hours.isOpen();
      }
    } catch (_) {}

    if (
      place?.opening_hours &&
      typeof place.opening_hours.open_now === "boolean"
    ) {
      return !!place.opening_hours.open_now;
    }
    return false; // conservative default
  }

  function rebuild() {
    if (!window.venueIndex || !window.venueIndex.values) return;
    const out = [];
    for (const rec of window.venueIndex.values()) {
      const loc = rec?.place?.geometry?.location;
      if (!loc) continue;
      if (computeIsOpenNow(rec)) {
        out.push({ coordinates: [loc.lat(), loc.lng()], isOpenNow: true });
      }
    }
    window.__venuesOpenNow = out;
    // If SQI is present, refresh it
    if (
      window.GlowSQI &&
      window.__glow_sqi_instance &&
      typeof window.__glow_sqi_instance.updateCenter === "function"
    ) {
      window.__glow_sqi_instance.updateCenter();
    }
  }

  // Expose manual trigger
  window.__rebuildOpenNowForSQI = rebuild;

  // Poll every 5 seconds to keep it fresh (and catch late-loaded places/details)
  setInterval(rebuild, 5000);
  // Also run once on load
  if (document.readyState === "complete") rebuild();
  else window.addEventListener("load", rebuild);
})();