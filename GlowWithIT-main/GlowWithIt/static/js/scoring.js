// these are the categories that will be used as features for providing the safe plans for the users
export const optionCategories = [

  "LIGHT", "COMPANY", "VENUE", "NAVIGATION", "EMERGENCY", "BATTERY", "AWARE"
];

// Q1 — transport mode
function getQuestion1(user) {

  if (user.q1_mode) return user.q1_mode; // "walking" | "tram/train" | "rideshare" | "driving"

  // fallback inference
  const transportationMode = Array.isArray(user.transportMode) ? user.transportMode : [];

  if (transportationMode.includes("walking"))      return "walking";
  if (transportationMode.includes("tram/train"))   return "tram/train";
  if (transportationMode.includes("rideshare"))    return "rideshare";
  if (transportationMode.includes("driving"))      return "driving";
  return null;
}

// Q2 — time of travel
function getQuestion2(user) {
  if (user.q2_time) return user.q2_time; // "before-10" | "10-12" | "after-midnight"

  // fallback inference
  switch (user.workSchedule) {
    case "early-evening": return "before-10";
    case "late-evening":  return "10-12";
    case "overnight":     return "after-midnight";
    default: return null;
  }
}

// Q3 — primary safety concern 
function getQuestion3(user) {
  if (user.q3_unease) return user.q3_unease; // "harassment" | "isolation" | "poor-lighting" | "lost"

  const concern = (user.primaryConcerns || [])[0];
  if (!concern) return null;

  if (concern === "harassment")        return "harassment";
  if (concern === "isolated-areas")    return "isolation";
  if (concern === "poor-lighting")     return "poor-lighting";
  if (concern === "lost")              return "lost";
  // ignore broad/unsupported fallbacks:
  return null;
}

// Q4 — preferred stop/venue
function getQuestion4(user) {
  return user.q4_stop || null; // "busy-bright" | "quiet-crowded"
}

// Q5 — phone battery 
function getQuestion5(user) {
  return user.q5_battery || null; // "gt60" | "30-60" | "<30"
}

// Q6 — company 
function getQuestion6(user) {
  return user.q6_company || null; // "alone" | "friend" | "group"
}

// Q7 — safety features 
function getQuestion7(user) {
  if (Array.isArray(user.q7_powers)) return user.q7_powers; // ["sos","location-share","timer","venues"]

  // fallback inference from a generic feature set
  const features = new Set(user.safetyFeatures || []);
  const result = [];
  if (features.has("emergency-button"))   result.push("sos");
  if (features.has("check-in-reminders")) result.push("timer");
  if (features.has("safe-spaces-map"))    result.push("venues");
  if (features.has("location-share") || features.has("share-location")) result.push("location-share");
  return result;
}



export function calculateScoreForAssessmentForm(user) {
  const scores = Object.fromEntries(optionCategories.map(k => [k, 0]));

  // Q1 — transport mode
  switch (getQuestion1(user)) {
    case "walking":
      scores.LIGHT += 2;
      scores.COMPANY += 1;
      scores.VENUE += 1;
      scores.NAVIGATION += 2;
      scores.AWARE += 1;
      break;

    case "tram/train":
      scores.LIGHT += 1;
      scores.COMPANY += 1;
      scores.NAVIGATION += 2;
      scores.VENUE += 1;
      break;

    case "rideshare":
      scores.LIGHT += 1;
      scores.COMPANY += 1;
      scores.VENUE += 1;
      scores.AWARE += 1;
      break;

    case "driving":
      scores.NAVIGATION += 1;
      scores.AWARE += 2;
      break;
  }

  // Q2 — time of travel
  switch (getQuestion2(user)) {
    case "10-12":
      scores.LIGHT += 1;
      scores.COMPANY += 1;
      break;
    case "after-midnight":
      scores.LIGHT += 2;
      scores.COMPANY += 2;
      scores.VENUE += 1;
      scores.EMERGENCY += 1;
      break;
  
  }

  // Q3 — primary concern
  switch (getQuestion3(user)) {
    case "harassment":
      scores.COMPANY += 2;
      scores.VENUE += 1;
      scores.EMERGENCY += 1;
      scores.AWARE += 1;
      break;
    case "isolation":
      scores.COMPANY += 3;
      scores.VENUE += 1;
      break;
    case "poor-lighting":
      scores.LIGHT += 3;
      break;
    case "lost":
      scores.NAVIGATION += 3;
      break;
  }

  // Q4 — venue preference
  switch (getQuestion4(user)) {

    case "busy-bright":
      scores.LIGHT += 1;
      scores.COMPANY += 2;
      scores.VENUE += 1;
      break;
    case "quiet-crowded":
      scores.VENUE += 3;
      break;
  }

  // Q5 — battery
  switch (getQuestion5(user)) {
    case "30-60":
      scores.BATTERY += 1;
      break;
    case "<30":
      scores.EMERGENCY += 1;
      scores.BATTERY += 3;
      break;
    // "gt60" => no action
  }

  // Q6 — company
  switch (getQuestion6(user)) {
    case "alone":
      scores.LIGHT += 1;
      scores.COMPANY += 2;
      scores.VENUE += 1;
      scores.NAVIGATION += 1;
      scores.AWARE += 1;
      break;
    case "friend":
      scores.COMPANY += 1;
      break;
    case "group":
      // Often reduces risk; no extra tips needed by default
      break;
  }

  // Q7 — selected powers
  const pb = new Set(getQuestion7(user));
  if (pb.has("sos"))             scores.EMERGENCY += 2;
  if (pb.has("location-share"))  scores.COMPANY += 1;
  if (pb.has("timer"))           scores.AWARE += 2;
  if (pb.has("venues"))          scores.VENUE += 2;

  return scores;
}

// Flags for UI
export function provideCallToActionPlan(user) {
  const p = new Set(getQuestion7(user));

  return {
    showSOS:    p.has("sos"),
    showShare:  p.has("location-share"), 
    showTimer:  p.has("timer"),
    showVenues: p.has("venues"),
  };
}

// Top N categories
export function top3Categories(scores, n = 3) {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// Tips 
export const scoringTips = {
  LIGHT: [
    "<i class='bi bi-brightness-high me-1'></i> Stick to well-lit main roads; skip parks/laneways after midnight.",
    "<i class='bi bi-arrow-repeat me-1'></i> If a block looks dim, slide one street over to stay in shopfront light."
  ],
  COMPANY: [
    "<i class='bi bi-people me-1'></i> Drift toward people: late-open grocers, taxi ranks, busy venues.",
    "<i class='bi bi-telephone me-1'></i> Walk the last blocks while on a quick call or voice note with a buddy."
  ],
  VENUE: [
    "<i class='bi bi-shop me-1'></i> Pick a staffed spot on your route (servo, 24/7 chemist, PSO area).",
    "<i class='bi bi-door-open me-1'></i> If you need to wait, choose somewhere staff can see you."
  ],
  EMERGENCY: [
    "<i class='bi bi-exclamation-triangle me-1'></i> Keep 000 / 106 / 112 one-tap ready; know a nearby Safe Haven.",
    "<i class='bi bi-alarm me-1'></i> Set a quick check-in time with a friend before you head off."
  ],
  NAVIGATION: [
    "<i class='bi bi-signpost-2 me-1'></i> Use big landmarks: main roads, tram spines, major intersections.",
    "<i class='bi bi-arrow-counterclockwise me-1'></i> Pre-decide a turn-back point—rerouting is totally fine."
  ],
  BATTERY: [
    "<i class='bi bi-battery-half me-1'></i> Under 30%? Lower brightness and close power-hungry apps.",
    "<i class='bi bi-chat-dots me-1'></i> Save a pre-filled SMS for quick contact without data."
  ],
  AWARE: [
    "<i class='bi bi-ear me-1'></i> Keep one ear free; scan corners and doorways ahead.",
    "<i class='bi bi-key me-1'></i> Keep phone/keys in hand; avoid bag rummaging on the move."
  ]
};

// Build a 3-step plan from top categories
export function buildPersonalisedSafetyPlan(top) {
  const plan = [];

  if (top.includes("LIGHT") || top.includes("NAVIGATION")) {
    plan.push("Head to a well-lit main road and avoid laneways/parks.");
  }
  if (top.includes("COMPANY") || top.includes("VENUE")) {
    plan.push("Move toward a staffed or well-used place while you travel.");
  }
  if (top.includes("EMERGENCY")) {
    plan.push("Keep 000 / 106 / 112 one-tap ready; arrange a quick check-in.");
  }
  if (plan.length < 3 && top.includes("BATTERY")) {
    plan.push("Save battery: lower brightness and close heavy apps to keep maps/calls alive.");
  }

  return plan.slice(0, 3);
}
