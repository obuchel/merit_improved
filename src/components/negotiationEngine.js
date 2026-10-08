// negotiationEngine.js
// Revenue-grounded negotiation engine
// Klein, Faratin, Sayama & Bar-Yam — Annealing Mediator Protocol
// Utility functions denominated in €, calibrated by XGBoost predictions
// Seasonal leverage derived from XGBoost sensitivity analysis

import { XGBOOST_TREES } from '../xgboost_trees_data.js';

// ─── XGBOOST SENSITIVITY ENGINE ─────────────────────────────────────────────
// Runs the embedded decision trees across months & occupancy to derive
// how strong the hotel's bargaining position is for THIS specific RFP.

function evalTree(nodes, features) {
  let node = nodes[0];
  while (node.length === 4) {
    const [fIdx, threshold, yes, no] = node;
    const val = features[fIdx];
    node = nodes[(val === null || val === undefined || Number.isNaN(val) || val >= threshold) ? no : yes];
  }
  return node[0];
}

function xgbPredict(model, featureValues) {
  let sum = model.b;
  for (const tree of model.t) sum += evalTree(tree, featureValues);
  return sum;
}

function predictSingle(modelName, featureDict) {
  const model = XGBOOST_TREES[modelName];
  if (!model) return null;
  const vals = model.f.map(f => featureDict[f] ?? 0);
  return xgbPredict(model, vals);
}

const SEASON_MAP = { 12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3 };

/**
 * Compute seasonal leverage factors by running XGBoost across months & occupancy.
 * Returns { adrLeverage, pickupLeverage, conversionLeverage, fnbLeverage, demandPressure }
 * All values are ratios: >1 = hotel has strong position, <1 = weak position.
 */
export function computeSeasonalLeverage(rfp) {
  const arrival = new Date(rfp.arrival_date);
  const departure = new Date(rfp.departure_date);
  const inquiry = new Date(rfp.inquiry_date);
  const nights = Math.ceil((departure - arrival) / (1000 * 60 * 60 * 24)) || 1;
  const leadTime = Math.ceil((arrival - inquiry) / (1000 * 60 * 60 * 24));
  const month = arrival.getMonth() + 1;
  const dayOfWeek = (arrival.getDay() + 6) % 7;
  const isWeekend = dayOfWeek >= 5 ? 1 : 0;
  const season = SEASON_MAP[month] ?? 2;
  const attendees = Number(rfp.attendees) || 75;
  const roomBlock = Number(rfp.room_block) || 50;
  let occ = Number(rfp.forecasted_occupancy) || 0.75;
  if (occ < 1) occ *= 100;
  const eventTypeMap = { 'Wedding/Social': 0, 'Corporate': 1, 'Association': 2, 'Government': 3, 'Other': 4 };
  const priorityMap = { 'Low': 0, 'Medium': 1, 'High': 2 };
  const eventTypeEncoded = eventTypeMap[rfp.event_type] ?? 1;
  const priorityEncoded = priorityMap[rfp.client_priority] ?? 1;
  const roomsPerAttendee = attendees > 0 ? roomBlock / attendees : 1;
  const totalRoomNights = roomBlock * nights;

  // Base features for this RFP
  const baseFeatures = {
    month, day_of_week: dayOfWeek, is_weekend: isWeekend, season,
    forecasted_occupancy: occ, lead_time: leadTime, nights, attendees,
    room_block: roomBlock, rooms_per_attendee: roomsPerAttendee,
    total_room_nights: totalRoomNights, event_type_encoded: eventTypeEncoded,
    priority_encoded: priorityEncoded, quoted_adr: 0, baseline_adr: 164, rate_ratio: 0,
  };

  // 1. Current month prediction
  const currentAdr = predictSingle('baseline_adr', baseFeatures) ?? 164;
  const currentPickup = predictSingle('pickup', { ...baseFeatures, baseline_adr: currentAdr }) ?? 0.79;
  const currentConv = predictSingle('conversion', { ...baseFeatures, baseline_adr: currentAdr }) ?? 0.65;
  const currentFnb = predictSingle('fnb', baseFeatures) ?? 60;

  // 2. Sweep all 12 months to get annual baseline
  const monthlyAdrs = [];
  const monthlyPickups = [];
  const monthlyConvs = [];
  const monthlyFnbs = [];

  for (let m = 1; m <= 12; m++) {
    const s = SEASON_MAP[m] ?? 2;
    const f = { ...baseFeatures, month: m, season: s };
    const adr = predictSingle('baseline_adr', f) ?? 164;
    monthlyAdrs.push(adr);
    monthlyPickups.push(predictSingle('pickup', { ...f, baseline_adr: adr }) ?? 0.79);
    monthlyConvs.push(predictSingle('conversion', { ...f, baseline_adr: adr }) ?? 0.65);
    monthlyFnbs.push(predictSingle('fnb', f) ?? 60);
  }

  const avgAdr = monthlyAdrs.reduce((a, b) => a + b, 0) / 12;
  const avgPickup = monthlyPickups.reduce((a, b) => a + b, 0) / 12;
  const avgConv = monthlyConvs.reduce((a, b) => a + b, 0) / 12;
  const avgFnb = monthlyFnbs.reduce((a, b) => a + b, 0) / 12;

  // 3. Occupancy sensitivity: sweep 50-95% at current month
  const occAdrs = [];
  for (let o = 50; o <= 95; o += 5) {
    const f = { ...baseFeatures, forecasted_occupancy: o };
    occAdrs.push(predictSingle('baseline_adr', f) ?? 164);
  }
  const occMin = Math.min(...occAdrs);
  const occMax = Math.max(...occAdrs);
  const occPercentile = occMax > occMin ? (currentAdr - occMin) / (occMax - occMin) : 0.5;

  // 4. Compute leverage ratios
  const adrLeverage = avgAdr > 0 ? currentAdr / avgAdr : 1;
  const pickupLeverage = avgPickup > 0 ? currentPickup / avgPickup : 1;
  const conversionLeverage = avgConv > 0 ? currentConv / avgConv : 1;
  const fnbLeverage = avgFnb > 0 ? currentFnb / avgFnb : 1;

  // Demand pressure: composite score 0-1 (1 = maximum hotel leverage)
  // Combines seasonal ADR strength + occupancy position
  const demandPressure = clamp(
    0.4 * (adrLeverage - 0.85) / 0.3 + 0.6 * occPercentile,
    0, 1
  );

  return {
    adrLeverage: Math.round(adrLeverage * 1000) / 1000,
    pickupLeverage: Math.round(pickupLeverage * 1000) / 1000,
    conversionLeverage: Math.round(conversionLeverage * 1000) / 1000,
    fnbLeverage: Math.round(fnbLeverage * 1000) / 1000,
    demandPressure: Math.round(demandPressure * 1000) / 1000,
    currentAdr: Math.round(currentAdr * 100) / 100,
    annualAvgAdr: Math.round(avgAdr * 100) / 100,
    monthlyAdrs: monthlyAdrs.map(v => Math.round(v * 100) / 100),
    occPercentile: Math.round(occPercentile * 1000) / 1000,
  };
}

// ─── ISSUE CONFIGURATION ────────────────────────────────────────────────────
// Ranges anchored to XGBoost predictions + real Nexus Hotel data (2023-2025)

// ─── DATA-DRIVEN EVENT PROFILES ─────────────────────────────────────────────
// Derived from 1,899 real events (1,455 booked + 444 lost), Nexus Hotel 2023-2025
//
// Source analysis:
//   F&B actual/pp: Wedding €126, Association €95, Corporate €85, SMERF €45, Tour €35
//   Space/attendee: Wedding €108, Association €92, Corporate €90, SMERF €47, Tour €24
//   Pickup actual: Tour 94%, Corporate 87%, SMERF 81%, Association 72%, Wedding 59%
//   Revenue mix:   Wedding 33R/42F/26S, Corporate 46R/35F/19S, Association 41R/44F/16S
//   Price losses:  Wedding 33%, Corporate 26%, Association 22%, SMERF 22%, Tour 18%
//   ADR won-lost:  Corporate -€5, Association -€7, Wedding +€6, Tour -€5

const EVENT_PROFILES = {
  'Wedding/Social': {
    fnb_pp: 126, space_per_attendee: 108, pickup: 0.588,
    price_sensitivity: 0.33,   // 33% of losses are price-related
    adr_elasticity: -0.06,     // weddings pay MORE and still book (won ADR > lost ADR)
    fnb_cogs: 0.58,            // higher quality food = lower margin
    rev_mix: { room: 0.33, fnb: 0.42, space: 0.26 },
    client_fnb_multiplier: 1.15,  // clients value wedding catering above cost
    client_space_multiplier: 1.4, // venue/ambiance premium for social events
  },
  'Corporate': {
    fnb_pp: 85, space_per_attendee: 90, pickup: 0.874,
    price_sensitivity: 0.26,
    adr_elasticity: 0.05,
    fnb_cogs: 0.65,
    rev_mix: { room: 0.46, fnb: 0.35, space: 0.19 },
    client_fnb_multiplier: 0.9,   // corporate clients see F&B as expected, not premium
    client_space_multiplier: 1.2, // meeting space is functional need
  },
  'Association': {
    fnb_pp: 95, space_per_attendee: 92, pickup: 0.716,
    price_sensitivity: 0.22,
    adr_elasticity: 0.07,
    fnb_cogs: 0.62,
    rev_mix: { room: 0.41, fnb: 0.44, space: 0.16 },
    client_fnb_multiplier: 1.1,
    client_space_multiplier: 1.1,
  },
  'SMERF': {
    fnb_pp: 45, space_per_attendee: 47, pickup: 0.814,
    price_sensitivity: 0.22,
    adr_elasticity: 0.02,
    fnb_cogs: 0.70,            // simpler food = higher margin
    rev_mix: { room: 0.52, fnb: 0.30, space: 0.19 },
    client_fnb_multiplier: 1.0,
    client_space_multiplier: 1.0,
  },
  'Tour/Travel': {
    fnb_pp: 35, space_per_attendee: 24, pickup: 0.939,
    price_sensitivity: 0.18,
    adr_elasticity: 0.05,
    fnb_cogs: 0.72,
    rev_mix: { room: 0.85, fnb: 0.10, space: 0.05 },
    client_fnb_multiplier: 0.7,   // tours care least about F&B
    client_space_multiplier: 0.5, // minimal space needs
  },
};

// Default for unknown event types
const DEFAULT_PROFILE = EVENT_PROFILES['Corporate'];

function getProfile(rfp) {
  return EVENT_PROFILES[rfp.event_type] || DEFAULT_PROFILE;
}

// ─── AMENITY COSTS (from hotel operational data) ────────────────────────────

const AMENITY_COSTS = {
  wifi_per_room_night: 4,
  late_checkout_per_room: 18,
  reception_per_person: 14,
  av_package_flat: 2200,
  gop_margin: 0.44,
};

// Client-perceived value (willingness to pay > hotel cost = negotiation surplus)
const AMENITY_CLIENT_VALUES = {
  wifi_per_room_night: 9,
  late_checkout_per_room: 25,
  reception_per_person: 20,
  av_package_flat: 3800,
};

export function buildIssues(predictions, rfp, leverage = null) {
  const { baseline_adr, fnb_per_person } = predictions;
  const profile = getProfile(rfp);
  const maxComp = Math.max(2, Math.ceil(rfp.room_block / 40));

  const dp = leverage?.demandPressure ?? 0.5;

  // ADR range: adjusted by event type price elasticity
  // Weddings have negative elasticity (can charge more), tours/corporate are price-sensitive
  const elasticityShift = profile.adr_elasticity; // positive = lost deals had higher ADR
  const adrFloorPct = 0.78 + dp * 0.12 + Math.max(0, elasticityShift);
  const adrCeilPct = 1.15 + dp * 0.07 - Math.max(0, -elasticityShift) * 0.5;

  // F&B max from real per-person spend for this event type
  const realFnbMax = Math.round(profile.fnb_pp * 1.2 / 5) * 5;
  const fnbMax = Math.max(realFnbMax, Math.round(fnb_per_person * 1.3 / 5) * 5) || 80;

  // Space discount: data shows wedding space is 26% of revenue (high value), tour is 5% (low)
  // Higher space revenue share = less willingness to discount
  const spaceImportance = profile.rev_mix.space; // 0.05 → 0.26
  const maxSpaceDiscount = Math.round((50 - spaceImportance * 80) * (1 - dp * 0.4));

  const adjMaxComp = Math.max(1, Math.round(maxComp * (1.2 - dp * 0.6)));

  return [
    { key: 'adr', label: 'ADR (€)', min: Math.round(baseline_adr * adrFloorPct / 5) * 5, max: Math.round(baseline_adr * adrCeilPct / 5) * 5, step: 5, type: 'continuous', unit: '€' },
    { key: 'fnb_credit', label: 'F&B Credit/person', min: 0, max: fnbMax, step: 5, type: 'continuous', unit: '€' },
    { key: 'space_discount', label: 'Space Discount', min: 0, max: Math.max(5, maxSpaceDiscount), step: 5, type: 'continuous', unit: '%' },
    { key: 'comp_rooms', label: 'Comp Rooms', min: 0, max: adjMaxComp, step: 1, type: 'continuous', unit: '' },
    { key: 'wifi', label: 'Free WiFi', type: 'binary' },
    { key: 'late_checkout', label: 'Late Checkout', type: 'binary' },
    { key: 'welcome_reception', label: 'Welcome Reception', type: 'binary' },
    { key: 'av_package', label: 'AV Package', type: 'binary' },
  ];
}

// ─── HOTEL UTILITY: NET REVENUE (€) ────────────────────────────────────────
// Calibrated with event-type-specific COGS margins and revenue mix

export function hotelNetRevenue(agreement, ctx) {
  const { predictions, rfp, nights, spaceBase, leverage, profile } = ctx;
  const dp = leverage?.demandPressure ?? 0.5;

  const roomRev = agreement.adr * rfp.room_block * nights * predictions.pickup_rate;
  const fnbGross = agreement.fnb_credit * rfp.attendees * nights;
  const fnbNet = fnbGross * (1 - profile.fnb_cogs); // event-type-specific COGS
  const spaceRev = spaceBase * (1 - agreement.space_discount / 100);

  // Opportunity cost scales with demand AND event type pickup
  // High pickup events (tours 94%) have lower comp room opportunity cost
  // Low pickup events (weddings 59%) = more unsold rooms anyway
  const pickupPenalty = predictions.pickup_rate > 0.85 ? 1.2 : 1.0;
  const opportunityCostMul = (1 + dp * 0.35) * pickupPenalty;

  const compCost = agreement.comp_rooms * agreement.adr * nights * opportunityCostMul;
  const wifiCost = agreement.wifi * rfp.room_block * nights * AMENITY_COSTS.wifi_per_room_night;
  const checkoutCost = agreement.late_checkout * rfp.room_block * predictions.pickup_rate * AMENITY_COSTS.late_checkout_per_room * opportunityCostMul;
  const receptionCost = agreement.welcome_reception * rfp.attendees * AMENITY_COSTS.reception_per_person;
  const avCost = agreement.av_package * AMENITY_COSTS.av_package_flat;

  return (roomRev + fnbNet + spaceRev) - (compCost + wifiCost + checkoutCost + receptionCost + avCost);
}

// ─── CLIENT UTILITY: PERCEIVED VALUE (€) ───────────────────────────────────
// Event-type-specific: weddings value ambiance/F&B, corporate values space/wifi

export function clientPerceivedValue(agreement, ctx) {
  const { predictions, rfp, nights, spaceBase, leverage, profile } = ctx;

  // Rack rate perception: higher in peak season
  const seasonalRackMul = 1.15 + (leverage?.demandPressure ?? 0.5) * 0.10;
  const rackRate = predictions.baseline_adr * seasonalRackMul;

  // Room savings: weighted by price sensitivity from real lost-business data
  // Wedding clients lost 33% to price → they value rate savings more
  const priceSensWeight = 0.8 + profile.price_sensitivity; // 0.98 → 1.13
  const roomSavings = Math.max(0, rackRate - agreement.adr) * rfp.room_block * nights * priceSensWeight;

  // F&B value: event-type multiplier from real spend patterns
  // Weddings value catering 1.15x its cost, corporate sees it as 0.9x
  const fnbValue = agreement.fnb_credit * rfp.attendees * nights * profile.client_fnb_multiplier;

  // Space savings: wedding clients value venue 1.4x, tours 0.5x
  const spaceSavings = spaceBase * agreement.space_discount / 100 * profile.client_space_multiplier;

  const compValue = agreement.comp_rooms * rackRate * nights;
  const wifiValue = agreement.wifi * rfp.room_block * nights * AMENITY_CLIENT_VALUES.wifi_per_room_night;
  const checkoutValue = agreement.late_checkout * rfp.room_block * AMENITY_CLIENT_VALUES.late_checkout_per_room;
  const receptionValue = agreement.welcome_reception * rfp.attendees * AMENITY_CLIENT_VALUES.reception_per_person;
  const avValue = agreement.av_package * AMENITY_CLIENT_VALUES.av_package_flat;

  let total = roomSavings + fnbValue + spaceSavings + compValue + wifiValue + checkoutValue + receptionValue + avValue;

  // Client priority adjustment (from RFP form)
  const priorityMul = { High: 0.85, Medium: 1.0, Low: 1.15 };
  total *= priorityMul[rfp.client_priority] || 1.0;

  return total;
}

// ─── BUILD CONTEXT (min/max + normalized utility fns) ───────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function buildContext(predictions, rfp) {
  const nights = Math.ceil((new Date(rfp.departure_date) - new Date(rfp.arrival_date)) / (1000 * 60 * 60 * 24)) || 1;
  const profile = getProfile(rfp);

  // Space base from real data: per-attendee rate × attendees × nights
  const spaceBase = profile.space_per_attendee * (Number(rfp.attendees) || 50) * nights;

  // Compute seasonal leverage from XGBoost sensitivity analysis
  const leverage = computeSeasonalLeverage(rfp);
  const issues = buildIssues(predictions, rfp, leverage);
  const ctx = { predictions, rfp, nights, spaceBase, leverage, profile };

  // Compute utility bounds across the full issue space
  const bestHotel = {}, worstHotel = {}, bestClient = {}, worstClient = {};
  for (const is of issues) {
    if (is.type === 'binary') {
      bestHotel[is.key] = 0;  worstHotel[is.key] = 1;
      bestClient[is.key] = 1; worstClient[is.key] = 0;
    } else if (is.key === 'adr') {
      // Adversarial: hotel wants high, client wants low
      bestHotel[is.key] = is.max;  worstHotel[is.key] = is.min;
      bestClient[is.key] = is.min; worstClient[is.key] = is.max;
    } else if (is.key === 'fnb_credit') {
      // Win-win: hotel earns 35% margin, client gets F&B value
      bestHotel[is.key] = is.max;  worstHotel[is.key] = is.min;
      bestClient[is.key] = is.max; worstClient[is.key] = is.min;
    } else {
      // Adversarial: space_discount, comp_rooms — hotel gives, client receives
      bestHotel[is.key] = is.min;  worstHotel[is.key] = is.max;
      bestClient[is.key] = is.max; worstClient[is.key] = is.min;
    }
  }

  const hotelMax = hotelNetRevenue(bestHotel, ctx);
  const hotelMin = hotelNetRevenue(worstHotel, ctx);
  const clientMax = clientPerceivedValue(bestClient, ctx);
  const clientMin = clientPerceivedValue(worstClient, ctx);
  const hotelRange = hotelMax - hotelMin || 1;
  const clientRange = clientMax - clientMin || 1;

  return {
    ...ctx, issues, hotelMax, hotelMin, clientMax, clientMin, leverage,
    hotelUtility: (a) => (hotelNetRevenue(a, ctx) - hotelMin) / hotelRange,
    clientUtility: (a) => (clientPerceivedValue(a, ctx) - clientMin) / clientRange,
    hotelEuros: (a) => hotelNetRevenue(a, ctx),
    clientEuros: (a) => clientPerceivedValue(a, ctx),
  };
}

// ─── AGREEMENT GENERATION & MUTATION ────────────────────────────────────────

export function randomAgreement(issues) {
  const a = {};
  for (const is of issues) {
    if (is.type === 'binary') a[is.key] = Math.random() > 0.5 ? 1 : 0;
    else {
      const steps = Math.round((is.max - is.min) / is.step);
      a[is.key] = is.min + Math.floor(Math.random() * (steps + 1)) * is.step;
    }
  }
  return a;
}

function mutate(agreement, issues) {
  const a = { ...agreement };
  const is = issues[Math.floor(Math.random() * issues.length)];
  if (is.type === 'binary') a[is.key] = a[is.key] === 1 ? 0 : 1;
  else {
    const dir = Math.random() > 0.5 ? 1 : -1;
    const mag = Math.ceil(Math.random() * 3);
    a[is.key] = clamp(a[is.key] + dir * is.step * mag, is.min, is.max);
  }
  return a;
}

function smartMutate(agreement, proposerFn, issues) {
  let best = null, bestU = -Infinity;
  for (let i = 0; i < 5; i++) {
    const c = mutate(agreement, issues);
    const u = proposerFn(c);
    if (u > bestU) { bestU = u; best = c; }
  }
  return best || mutate(agreement, issues);
}

// ─── VOTE ───────────────────────────────────────────────────────────────────

function vote(currentU, lastU) {
  const d = currentU - lastU;
  if (d > 0.015) return 1;
  if (d > -0.003) return 0;
  if (d > -0.02) return -1;
  return -2;
}

// ─── ANNEALING MEDIATOR PROTOCOL ────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  maxRounds: 300,
  initialTemp: 1.8,
  coolingRate: 0.985,
  initialTokens: 4,
};

export function runNegotiation(negCtx, config = {}) {
  const { issues, hotelUtility, clientUtility } = negCtx;
  const { maxRounds, initialTemp, coolingRate, initialTokens } = { ...DEFAULT_CONFIG, ...config };

  let current = randomAgreement(issues);
  let bestAccepted = { ...current }, bestSW = -Infinity;
  let T = initialTemp, hTok = initialTokens, cTok = initialTokens, hOver = 0, cOver = 0;
  let lastH = hotelUtility(current), lastC = clientUtility(current);

  const history = [{
    round: 0, agreement: { ...current },
    hotelUtility: lastH, clientUtility: lastC, socialWelfare: lastH + lastC,
    accepted: true, temperature: T, hotelVote: 1, clientVote: 1,
    hotelTokens: hTok, clientTokens: cTok, event: 'initial', proposer: null,
  }];

  for (let r = 1; r <= maxRounds; r++) {
    const isH = r % 2 === 0;
    const proposal = smartMutate(current, isH ? hotelUtility : clientUtility, issues);
    const ph = hotelUtility(proposal), pc = clientUtility(proposal), sw = ph + pc;
    const hv = vote(ph, lastH), cv = vote(pc, lastC), agg = hv + cv;
    let accepted = false, event = 'rejected';

    if (agg >= 0) {
      accepted = true;
      event = agg >= 2 ? 'mutual_accept' : 'weak_accept';
      if (hv < 0 && cv > 0) {
        if (cTok > 0 && (cOver - hOver) < 3) { cTok--; hTok++; cOver++; event = 'client_override'; }
        else { accepted = false; event = 'blocked'; }
      } else if (cv < 0 && hv > 0) {
        if (hTok > 0 && (hOver - cOver) < 3) { hTok--; cTok++; hOver++; event = 'hotel_override'; }
        else { accepted = false; event = 'blocked'; }
      }
    } else {
      const ap = Math.min(1, Math.exp(agg / T));
      if (Math.random() < ap * 0.25) { accepted = true; event = 'annealing_accept'; }
    }

    if (accepted) {
      current = { ...proposal }; lastH = ph; lastC = pc;
      if (sw > bestSW) { bestSW = sw; bestAccepted = { ...proposal }; }
    }

    T *= coolingRate;
    history.push({
      round: r, agreement: accepted ? { ...proposal } : { ...current },
      hotelUtility: accepted ? ph : lastH, clientUtility: accepted ? pc : lastC,
      socialWelfare: accepted ? sw : lastH + lastC,
      accepted, temperature: T, hotelVote: hv, clientVote: cv,
      hotelTokens: hTok, clientTokens: cTok, event,
      proposer: isH ? 'hotel' : 'client',
    });
  }

  return { history, bestAgreement: bestAccepted, bestSocialWelfare: bestSW };
}

// ─── PARETO FRONTIER ────────────────────────────────────────────────────────

export function estimatePareto(negCtx) {
  const { issues, hotelUtility, clientUtility } = negCtx;
  const pts = [];
  for (let i = 0; i < 400; i++) {
    const a = randomAgreement(issues);
    pts.push({ h: hotelUtility(a), c: clientUtility(a) });
  }
  for (let alpha = 0; alpha <= 1; alpha += 0.04) {
    let b = randomAgreement(issues), bs = alpha * hotelUtility(b) + (1 - alpha) * clientUtility(b);
    for (let j = 0; j < 200; j++) {
      const c = mutate(b, issues);
      const s = alpha * hotelUtility(c) + (1 - alpha) * clientUtility(c);
      if (s > bs) { b = c; bs = s; }
    }
    pts.push({ h: hotelUtility(b), c: clientUtility(b) });
  }
  pts.sort((a, b) => a.h - b.h);
  const frontier = [];
  let maxC = -Infinity;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].c > maxC) { maxC = pts[i].c; frontier.push(pts[i]); }
  }
  frontier.sort((a, b) => a.h - b.h);
  return frontier;
}

// ─── AGREEMENT → STRATEGY CARD ─────────────────────────────────────────────

export function agreementToStrategy(agreement, negCtx) {
  const { predictions, rfp, nights, spaceBase, hotelUtility, clientUtility, hotelEuros, clientEuros, profile } = negCtx;

  const roomRevenue = Math.round(agreement.adr * rfp.room_block * nights * predictions.pickup_rate);
  const fnbRevenue = Math.round(agreement.fnb_credit * rfp.attendees * nights);
  const spaceRevenue = Math.round(spaceBase * (1 - agreement.space_discount / 100));
  const totalRevenue = roomRevenue + fnbRevenue + spaceRevenue;
  const netRev = Math.round(hotelEuros(agreement));
  const roomNights = rfp.room_block * nights;

  const hU = hotelUtility(agreement), cU = clientUtility(agreement);
  const baseConv = predictions.conversion_prob;
  const conversionProb = Math.round(clamp(baseConv + (cU - 0.5) * 0.3, 0.2, 0.95) * 100);

  const includes = [];
  if (agreement.comp_rooms > 0) includes.push(`${agreement.comp_rooms} comp rooms`);
  if (agreement.fnb_credit > 0) includes.push(`€${agreement.fnb_credit}/person F&B credit`);
  if (agreement.space_discount > 0) includes.push(`${agreement.space_discount}% space discount`);
  if (agreement.wifi) includes.push('Free WiFi');
  if (agreement.late_checkout) includes.push('Late checkout');
  if (agreement.welcome_reception) includes.push('Welcome reception');
  if (agreement.av_package) includes.push('AV package included');

  const baselineRoomRev = predictions.baseline_adr * rfp.room_block * nights * predictions.pickup_rate;
  const roi = baselineRoomRev > 0 ? Math.round((totalRevenue / baselineRoomRev - 1) * 100) : 0;

  return {
    name: 'Negotiated Optimum',
    risk: 'Balanced',
    adr: agreement.adr,
    pickupRate: Math.round(predictions.pickup_rate * 100),
    conversionProb,
    gviIndex: roomNights > 0 ? Math.round(netRev / roomNights) : 0,
    roomRevenue, fnbRevenue, spaceRevenue, totalRevenue,
    expectedProfit: Math.round(netRev * AMENITY_COSTS.gop_margin),
    riskAdjustedValue: Math.round(netRev * AMENITY_COSTS.gop_margin * (conversionProb / 100)),
    roiVsBaseline: (roi >= 0 ? '+' : '') + roi + '%',
    color: 'negotiated', recommended: false, negotiated: true,
    hotelUtility: hU, clientUtility: cU,
    hotelNetRevEuros: netRev,
    clientValueEuros: Math.round(clientEuros(agreement)),
    socialWelfare: hU + cU,
    includes,
    subtitle: 'Apply Negotiated Agreement',
    agreement: { ...agreement },
  };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

export function issueNorm(issues, key, val) {
  const is = issues.find(i => i.key === key);
  if (!is) return 0;
  if (is.type === 'binary') return val;
  return is.max === is.min ? 0 : (val - is.min) / (is.max - is.min);
}
