// modelLoader.js — Pure JavaScript XGBoost (no Pyodide, no WASM)
// Trees from rfp_models_fixed.pkl (retrained v4 with Cvent+room+meeting features)
// 4 XGBRegressor: pickup(150 trees), conversion(300), baseline_adr(120), fnb(130)

import { XGBOOST_TREES } from './xgboost_trees_data.js';

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

// ─── Encoding Maps ───────────────────────────────────────────────────────────

const EVENT_TYPE_MAP = { 'Corporate': 0, 'Association': 1, 'Wedding/Social': 2, 'SMERF': 3, 'Tour/Travel': 4 };
const PRIORITY_MAP = { 'Low': 0, 'Medium': 1, 'High': 2 };
const SEASON_MAP = { 12:0,1:0,2:0, 3:1,4:1,5:1, 6:2,7:2,8:2, 9:3,10:3,11:3 };
const EVENT_FORMAT_MAP = { 'In-person': 0, 'Virtual': 1, 'Hybrid': 2 };
const EVENT_CONFIG_MAP = { 'Rooms Only': 0, 'Meeting Only': 1, 'Full Package': 2 };
const LEAD_SOURCE_MAP = { 'Sales Call':0,'Cvent':1,'Third-Party Planner':2,'Website':3,'Direct Inquiry':4,'Repeat Client':5,'RFP':6,'Referral':7 };
const MARKET_SEGMENT_MAP = { 'Technology':0,'Healthcare':1,'Finance':2,'Legal':3,'Education':4,'Non-Profit':5,'Government':6,'Real Estate':7,'Professional Services':8,'Trade/Manufacturing':9,'SMERF':10,'Social':11,'Travel':12,'Association':13,'Other':14 };

// ─── Feature Engineering ─────────────────────────────────────────────────────

function engineerFeatures(rfpData) {
  const arrival = new Date(rfpData.arrival_date);
  const departure = new Date(rfpData.departure_date);
  const inquiry = new Date(rfpData.inquiry_date);

  const nights = Math.max(1, Math.ceil((departure - arrival) / 864e5));
  const leadTime = Math.max(0, Math.ceil((arrival - inquiry) / 864e5));
  const month = arrival.getMonth() + 1;
  const dow = (arrival.getDay() + 6) % 7;
  const isWeekend = dow >= 5 ? 1 : 0;
  const season = SEASON_MAP[month] ?? 2;

  const attendees = Number(rfpData.attendees) || 75;
  const roomBlock = Number(rfpData.room_block) || 50;
  let occ = Number(rfpData.forecasted_occupancy) || 0.75;
  if (occ < 1) occ *= 100;

  return {
    // Core
    month, day_of_week: dow, is_weekend: isWeekend, season,
    forecasted_occupancy: occ, lead_time: leadTime, nights,
    attendees, room_block: roomBlock,
    rooms_per_attendee: attendees > 0 ? roomBlock / attendees : 1,
    total_room_nights: roomBlock * nights,
    event_type_encoded: EVENT_TYPE_MAP[rfpData.event_type] ?? 0,
    priority_encoded: PRIORITY_MAP[rfpData.client_priority] ?? 1,
    arrival_month_sin: Math.sin(2 * Math.PI * month / 12),
    arrival_month_cos: Math.cos(2 * Math.PI * month / 12),
    length_of_stay_category: nights === 1 ? 0 : nights <= 3 ? 1 : 2,

    // Cvent metadata
    event_format_encoded: EVENT_FORMAT_MAP[rfpData.event_format] ?? 0,
    event_config_encoded: EVENT_CONFIG_MAP[rfpData.event_configuration] ?? 2,
    lead_source_encoded: LEAD_SOURCE_MAP[rfpData.lead_source] ?? 4,
    market_segment_encoded: MARKET_SEGMENT_MAP[rfpData.market_segment] ?? 14,
    budget_provided: rfpData.budget_provided ? 1 : 0,
    budget_ratio: 0,
    destinations_considered: Number(rfpData.destinations_considered) || 2,
    decision_days: Number(rfpData.decision_days) || 10,
    response_due_days: Number(rfpData.response_due_days) || 7,
    has_special_requirements: rfpData.special_requirements ? 1 : 0,
    has_meeting_space: rfpData.has_meeting_space !== undefined ? (rfpData.has_meeting_space ? 1 : 0) : 1,
    has_fnb_requirements: rfpData.has_fnb_requirements !== undefined ? (rfpData.has_fnb_requirements ? 1 : 0) : 1,

    // Room mix
    num_room_types: Number(rfpData.num_room_types) || 3,
    pct_standard_rooms: Number(rfpData.pct_standard_rooms) || 60,
    pct_premium_rooms: Number(rfpData.pct_premium_rooms) || 40,
    has_suites: rfpData.has_suites ? 1 : 0,
    rate_spread: Number(rfpData.rate_spread) || 50,
    night_variance_pct: Number(rfpData.night_variance_pct) || 5,

    // Meeting rooms
    num_meeting_rooms: Number(rfpData.num_meeting_rooms) || 1,
    num_sessions: Number(rfpData.num_sessions) || 2,
    total_meeting_hours: Number(rfpData.total_meeting_hours) || 8,
    uses_ballroom: rfpData.uses_ballroom ? 1 : 0,
    uses_boardroom: rfpData.uses_boardroom ? 1 : 0,
    max_av_level: Number(rfpData.max_av_level) || 2,
    has_premium_av: rfpData.has_premium_av ? 1 : 0,
    num_fnb_types: Number(rfpData.num_fnb_types) || 3,
    has_dinner: rfpData.has_dinner ? 1 : 0,
    has_reception: rfpData.has_reception ? 1 : 0,
    has_evening_session: rfpData.has_evening_session ? 1 : 0,
    full_day_pct: Number(rfpData.full_day_pct) || 50,
    avg_room_utilization: Number(rfpData.avg_room_utilization) || 0.7,

    // Rate-dependent (filled after baseline_adr prediction)
    quoted_adr: 0, baseline_adr: 164, rate_ratio: 0,
    quote_to_baseline_ratio: 0, revenue_per_attendee: 0, revenue_per_room_night: 0,

    _nights: nights, _roomBlock: roomBlock, _attendees: attendees,
  };
}

// ─── Prediction ──────────────────────────────────────────────────────────────

function predictModel(modelName, allFeatures) {
  const model = XGBOOST_TREES[modelName];
  if (!model) return null;
  return xgbPredict(model, model.f.map(f => allFeatures[f] ?? 0));
}

function validateBaselineAdr(raw, f) {
  if (raw >= 100 && raw <= 400) return raw;
  let adr = 164;
  adr += f.forecasted_occupancy < 50 ? -15 : f.forecasted_occupancy < 70 ? -5 : f.forecasted_occupancy < 85 ? 0 : 10;
  adr += f.is_weekend ? 8 : 0;
  return Math.max(135, Math.min(185, adr));
}

function validateFnb(raw) {
  return (raw >= 0 && raw <= 500) ? raw : 60;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const initPyodide = async () => {
  console.log('✅ XGBoost loaded (pure JS)');
  return true;
};

export const loadModel = async () => {
  console.log(`✅ ${Object.keys(XGBOOST_TREES).length} XGBoost models embedded`);
  return true;
};

export const predictStrategies = async (rfpData) => {
  try {
    console.log('🔮 Generating XGBoost predictions...');
    const f = engineerFeatures(rfpData);
    let used = 0;

    // 1. Baseline ADR
    let baseAdr = predictModel('baseline_adr', f);
    if (baseAdr !== null) { baseAdr = validateBaselineAdr(baseAdr, f); used++; }
    else baseAdr = 164;
    f.baseline_adr = baseAdr;

    // 2. Pickup
    f.quoted_adr = baseAdr;
    let pickup = predictModel('pickup', f);
    if (pickup !== null && pickup >= 0.3 && pickup <= 1) used++;
    else pickup = 0.79;

    // 3. Conversion
    f.quote_to_baseline_ratio = 1.0;
    f.revenue_per_attendee = (baseAdr * f.room_block * f.nights) / (f.attendees + 1);
    f.revenue_per_room_night = baseAdr;
    let conv = predictModel('conversion', f);
    if (conv !== null) { conv = Math.max(0.05, Math.min(0.95, conv)); used++; }
    else conv = 0.65;

    // 4. F&B
    let fnb = predictModel('fnb', f);
    if (fnb !== null) { fnb = validateFnb(fnb); used++; }
    else fnb = 60;

    const method = used > 0 ? `xgboost (${used}/4 models)` : 'fallback';
    console.log(`📊 ADR=€${baseAdr.toFixed(0)}, Pickup=${(pickup*100).toFixed(0)}%, Conv=${(conv*100).toFixed(0)}%, F&B=€${fnb.toFixed(0)}`);

    const { _nights: nights, _roomBlock: roomBlock, _attendees: attendees } = f;
    const roomNights = roomBlock * nights;
    const spaceBase = 8000;

    const buildStrategy = (name, risk, color, adrMul, pickupMul, convMul, fnbMul, spaceMul, recommended, subtitle) => {
      const adr = Math.round(baseAdr * adrMul);
      const pk = Math.min(0.99, pickup * pickupMul);
      const cv = Math.min(0.99, conv * convMul);
      const fb = fnb * fnbMul;
      const rr = adr * roomBlock * nights * pk;
      const fr = attendees * fb;
      const sr = spaceBase * spaceMul;
      const total = rr + fr + sr;
      const profit = Math.round(total * 0.44);
      return {
        name, risk, color, recommended,
        adr, pickupRate: Math.round(pk * 100), conversionProb: Math.round(cv * 100),
        gviIndex: roomNights > 0 ? Math.round(total / roomNights) : 250,
        roomRevenue: Math.round(rr), fnbRevenue: Math.round(fr), spaceRevenue: Math.round(sr),
        totalRevenue: Math.round(total), expectedProfit: profit,
        riskAdjustedValue: Math.round(profit * cv),
        roiVsBaseline: `+${Math.round((total / (baseAdr * roomBlock * nights * pickup) - 1) * 100)}%`,
        includes: [
          '2 comp rooms', `€${Math.round(fb)}/person F&B credit`,
          `${Math.round((1 - spaceMul) * 100)}% space discount`,
          'Free WiFi', ...(spaceMul < 0.8 ? ['Late checkout', 'Welcome reception'] : ['Welcome amenity'])
        ],
        subtitle,
      };
    };

    const strategies = [
      buildStrategy('Conservative Capture', 'Low Risk', 'success', 0.95, 1.06, 1.15, 0.9, 1.0, false, 'More conservative alternative'),
      buildStrategy('Optimal Balance', 'Medium Risk', 'warning', 1.0, 1.0, 1.0, 1.0, 0.7, true, 'Select Recommended Strategy'),
      buildStrategy('Premium Position', 'Higher Risk', 'error', 1.15, 0.95, 0.85, 1.2, 0.3, false, 'Higher profit, higher risk'),
    ];

    console.log(`✅ Strategies generated via ${method}`);
    return { success: true, strategies, prediction_method: method };
  } catch (error) {
    console.error('❌ Prediction error:', error);
    throw error;
  }
};
