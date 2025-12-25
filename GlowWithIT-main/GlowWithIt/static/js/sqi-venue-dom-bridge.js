// SQI Venue DOM Bridge (containerless)
// Looks for any .svm-status--open and checks the nearest .svm-dist for "NN m".
// Sets window.__domVenueOpenNowWithin300 = true if any are ≤ 300 m.

(function () {
  const LOG = false; // set true to see console logs

  function parseMeters(text) {
    if (!text) return NaN;
    const m = String(text).toLowerCase().match(/(\d+(?:\.\d+)?)\s*m\b/);
    return m ? parseFloat(m[1]) : NaN;
  }

  function findDistanceEl(fromEl) {
    // Prefer sibling/ancestor with .svm-dist
    let el = fromEl.closest('.svm-item, li, div') || fromEl.parentElement;
    if (!el) return null;
    return el.querySelector('.svm-dist') || fromEl.parentElement?.querySelector?.('.svm-dist');
  }

  function evaluate() {
    const openBadges = document.querySelectorAll('.svm-status.svm-status--open, .svm-status--open');
    let anyOpenWithin300 = false;

    openBadges.forEach(badge => {
      if (anyOpenWithin300) return;

      // find distance text near this badge
      const distEl = findDistanceEl(badge) || badge;
      const meters = parseMeters(distEl?.innerText || distEl?.textContent || '');

      if (LOG) console.debug('[SQI DOM]', { text: distEl?.innerText?.trim(), meters });

      if (!isNaN(meters) && meters <= 300) {
        anyOpenWithin300 = true;
      }
    });

    // publish flag + refresh SQI
    window.__domVenueOpenNowWithin300 = anyOpenWithin300;
    window.__glow_sqi_instance?.updateCenter?.();

    if (LOG) console.info('[SQI DOM] __domVenueOpenNowWithin300 =', anyOpenWithin300);
  }

  // Observe the whole document (safe + simple) so dynamic updates are caught
  const boot = () => {
    evaluate();
    const mo = new MutationObserver(() => evaluate());
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    // manual trigger if you ever need it
    window.__recheckVenueDomForSQI = evaluate;
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot);
})();
