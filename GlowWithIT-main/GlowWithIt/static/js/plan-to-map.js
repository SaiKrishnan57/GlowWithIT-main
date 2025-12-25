
export function planToActions(topCategories, pickedPowers = []) {
  const powers = new Set(pickedPowers); // ["sos","location-share","timer","venues"]

  return [
    
    // STEP 1 — Route choice
    (topCategories.includes("LIGHT") || topCategories.includes("NAVIGATION"))
      ? { id: 'route_safer', type: 'route', payload: { preferLit: true, avoidAlleys: true, preferMainRoads: true } }
      : { id: 'route_default', type: 'route', payload: { } },

    // STEP 2 — Places to move toward / wait
    (topCategories.includes("VENUE") || topCategories.includes("COMPANY"))
      ? { id: 'show_venues', type: 'layer', payload: { layer: 'safeVenues', visible: true } }
      : { id: 'hide_venues', type: 'layer', payload: { layer: 'safeVenues', visible: false } },

    // STEP 3 — Safety utilities
    (topCategories.includes("EMERGENCY") || powers.has("sos") || powers.has("timer") || powers.has("location-share"))
      ? { id: 'safety_util', type: 'utility', payload: { sos: powers.has("sos"), timer: powers.has("timer"), share: powers.has("location-share") } }
      : { id: 'no_util', type: 'utility', payload: { } },
  ];
}
