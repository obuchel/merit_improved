import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../firebase';

function useDemandEvents(rfp) {
  const [events, setEvents] = React.useState([]);
  React.useEffect(() => {
    if (!rfp?.arrival_date) return;
    getDocs(collection(db, 'demand_events')).then(snap => {
      const arr = rfp.arrival_date;
      const dep = rfp.departure_date || arr;
      const overlapping = snap.docs.map(d => d.data()).filter(ev =>
        ev.start_date && ev.end_date && ev.start_date <= dep && ev.end_date >= arr
      );
      setEvents(overlapping);
    }).catch(() => {});
  }, [rfp?.arrival_date, rfp?.departure_date]);
  return events;
}

const DEMAND_COLORS = { Low: '#3b82f6', Medium: '#f59e0b', High: '#f97316', Critical: '#ef4444' };
const DEMAND_ADR_MULT = { Low: 1.0, Medium: 1.05, High: 1.12, Critical: 1.20 };

const safeFmt = (v) => {
  const n = Number(v);
  return isNaN(n) ? '$0' : '$' + Math.round(n).toLocaleString();
};
import { doc, updateDoc, getDocs, collection, serverTimestamp } from 'firebase/firestore';
import { RefreshCw, Zap, BarChart3, Settings2, Play, ArrowLeft, ChevronRight, Check } from 'lucide-react';
import { loadModel, predictStrategies, initPyodide } from '../modelLoader';
import './Strategies.css';
import { XGBOOST_TREES_V8 as XGBOOST_TREES } from '../xgboost_trees_data_v8.js';
import { computeRoomsValue } from '../roomsValue';
import { DisplacementByNight, KeyFactors } from './DisplacementCards';
import PerturbationPanel from './PerturbationPanel';
import InfoTip from './InfoTip';
import { buildModelFeatures } from '../modelFeatures';
import { predictModel } from '../modelRuntime';
import { computeDisplacement } from '../transientDemand';
import { HOTEL_CONFIG } from '../hotelConfig';

// marketSignals.js has been discarded (see RankingView.jsx for the same
// change). CONFIG_DEFAULTS remains here as a plain constant: baseline_adr,
// displacement factor, meeting rate, and room count are real business/
// operational parameters, not model outputs.
const CONFIG_DEFAULTS = {
  ...HOTEL_CONFIG,
  displacement_factor:          0.28,  // legacy — no longer used; see computeDisplacement()
};

// ─── JS XGBoost engine (shares modelRuntime.js with RankingView.jsx — see
// that file's import comment and modelRuntime.js's header for the
// base_score calibration bug this fixes) ──────────────────────────────────
function predictSingle(name, dict) {
  return predictModel(XGBOOST_TREES, name, dict);
}

const BASELINE_ADR = 164;

// Returns { pickup_rate, conversion_prob, fnb_per_person, baseline_adr }.
// Uses pickup_ipw (selection-bias-corrected) as the pickup model, matching
// RankingView.jsx. Both views now build their feature vector through the
// same buildModelFeatures() (modelFeatures.js) — the real 70-feature-name
// vector the model was actually trained on — instead of each view
// maintaining its own separately hand-built (and separately wrong/drifted)
// feature dict.
function runJSXGBoost(rfp, config = CONFIG_DEFAULTS, modelCtx = {}) {
  const arrival   = new Date(rfp.arrival_date);
  const departure = new Date(rfp.departure_date);
  const nights    = Math.max(1, Math.round((departure - arrival) / 86400000));
  const roomBlock = Number(rfp.room_block || 50);
  const trn       = roomBlock * nights;
  const hasMtgNum = Number(rfp.has_meeting_space || 0);

  const bf = buildModelFeatures(rfp, {
    bookedMap:  modelCtx.bookedMap || {},
    allRfps:    modelCtx.allRfps   || [],
    totalRooms: config.total_rooms  || 220,
    baselineAdr: config.baseline_adr || BASELINE_ADR,
  });

  const adrRaw    = predictSingle('quoted_adr', bf);
  // pickup_ipw and conversion come back already calibrated (and, for
  // conversion, already through its correct sigmoid) from predictModel() —
  // do NOT sigmoid pickup again, it was never a logit-space model in
  // training. See modelRuntime.js header.
  const pickupCal = predictSingle('pickup_ipw', bf);
  const convCal   = predictSingle('conversion', bf);
  const fnbRaw    = predictSingle('fnb', bf);

  // Every one of the four real models must return a usable number here. No
  // silent substitution of a guessed constant when one doesn't — that would
  // display invented numbers as if they were model output. If any model
  // comes back null (missing tree data for this feature vector) or outside
  // a physically sane range, this is a genuine prediction failure: throw so
  // the caller (tryXGBoost) falls through to the Pyodide/pkl model path
  // instead of papering over it.
  if (adrRaw === null || adrRaw <= 60 || adrRaw >= 600) {
    throw new Error(`quoted_adr model returned an unusable value: ${adrRaw}`);
  }
  if (pickupCal === null) throw new Error('pickup_ipw model returned null — no prediction available');
  if (convCal === null) throw new Error('conversion model returned null — no prediction available');
  if (fnbRaw === null) throw new Error('fnb model returned null — no prediction available');

  // Clamping below bounds the REAL model output to a sane probability
  // range (models can occasionally extrapolate past [0,1] on unusual
  // inputs) — it never substitutes a different number, only clips the one
  // the model actually returned.
  const baselineAdrPred = Math.round(adrRaw);
  const pickup = Math.min(0.98, Math.max(0.35, pickupCal));
  const conv = Math.min(0.98, Math.max(0.15, convCal));
  const fnbPP = Math.max(hasMtgNum ? 25 : 20, fnbRaw);

  return {
    baseline_adr:    baselineAdrPred,
    pickup_rate:     pickup,
    conversion_prob: conv,
    fnb_per_person:  Math.round(fnbPP),
    room_nights:     trn,
    // meeting_space_base: total space revenue at standard config rate for this group
    meeting_space_base: hasMtgNum
      ? rfp.room_block * config.meeting_rate_per_room_night * nights
      : 0,
    // Stash the exact feature vector this RFP produced so the UI can show
    // "which features are most significant for this RFP" using real values
    // instead of re-deriving/guessing them. Underscore-prefixed so it's
    // obviously not itself a model output.
    _bf: bf,
    // The training data shows no relationship between quoted price and winning, and the
    // conversion model has no price input, so conversion is the same for every strategy.
    // (Placeholder price elasticity can be added once real win/loss-vs-quote history exists.)
    convAt: () => conv,
  };
}

// ─── MODEL EXPLAINABILITY (global feature importance × this RFP's values) ───
// Importance numbers below are importance_pct exported directly from the
// four trained models' feature_importance CSVs (quoted_adr, conversion,
// pickup_ipw, fnb) — not estimated. Labels come from the MERIT Data &
// Feature Dictionary (Unified Data Dictionary tab) wherever it has a
// confirmed one; a feature the dictionary itself flags as unresolved keeps
// its raw model name plus that flag, rather than getting an invented label.
// Importances of the CURRENT models (2026-10-07): ADR = mean |SHAP| of the retrained model; conversion = standardised
// logistic-regression weights; pickup/F&B = XGBoost gain share. Same numbers as final_variables_four_models_updated.png.
const FEATURE_GROUPS = [
 {
  "model": "quoted_adr",
  "title": "Quoted rate (ADR)",
  "metric": "mean |SHAP|, $ per night",
  "kind": "dollars",
  "fit": "Retrained, no price-derived inputs \u00b7 test R\u00b2 0.91 \u00b7 error \u00b1$6.32",
  "rows": [
   {
    "feature": "historical_demand_this_month",
    "label": "Typical demand this month",
    "unit": "count",
    "value": 10.377
   },
   {
    "feature": "tr_transient_adr",
    "label": "Transient rate on stay nights",
    "unit": "money",
    "value": 5.09
   },
   {
    "feature": "is_shoulder_season",
    "label": "Shoulder season arrival",
    "unit": "flag",
    "value": 3.338
   },
   {
    "feature": "Is_Compression_Date",
    "label": "Sold-out (compression) date",
    "unit": "flag",
    "value": 3.155
   },
   {
    "feature": "displacement_ema_7d",
    "label": "Recent displacement trend",
    "unit": "num",
    "value": 2.38
   },
   {
    "feature": "arrival_day_of_week",
    "label": "Arrival day of week (Mon=0)",
    "unit": "count",
    "value": 1.905
   },
   {
    "feature": "arrival_day_of_year",
    "label": "Arrival day of year",
    "unit": "count",
    "value": 1.264
   },
   {
    "feature": "segment_avg_revenue_intensity",
    "label": "Segment avg revenue intensity",
    "unit": "money",
    "value": 1.231
   }
  ]
 },
 {
  "model": "conversion",
  "title": "Chance of winning",
  "metric": "standardised weight (log-odds per 1 SD); + raises win chance",
  "kind": "signed",
  "fit": "Logistic regression \u00b7 AUC 0.76 (5-fold CV)",
  "rows": [
   {
    "feature": "on_books_occupancy_pct",
    "label": "Rooms already booked on stay nights",
    "unit": "pct",
    "value": -1.118
   },
   {
    "feature": "tr_transient_rooms_turned_away",
    "label": "Transient guests turned away",
    "unit": "count",
    "value": 0.947
   },
   {
    "feature": "forecasted_occupancy",
    "label": "Forecast hotel occupancy",
    "unit": "pct",
    "value": 0.815
   },
   {
    "feature": "tr_transient_occ_of_available",
    "label": "Transient occupancy of rooms left",
    "unit": "pct",
    "value": -0.608
   },
   {
    "feature": "lead_time_days",
    "label": "Lead time (days)",
    "unit": "count",
    "value": -0.458
   },
   {
    "feature": "historical_demand_this_month",
    "label": "Typical demand this month",
    "unit": "count",
    "value": -0.437
   },
   {
    "feature": "destinations_considered",
    "label": "Destinations client is comparing",
    "unit": "count",
    "value": -0.284
   },
   {
    "feature": "is_peak_arrival",
    "label": "Peak-season arrival",
    "unit": "flag",
    "value": 0.253
   }
  ]
 },
 {
  "model": "pickup_ipw",
  "title": "Pickup rate",
  "metric": "share of split gain (%)",
  "kind": "pct",
  "fit": "XGBoost \u00b7 R\u00b2 0.83 \u00b7 error \u00b10.043",
  "rows": [
   {
    "feature": "segment_avg_revenue_intensity",
    "label": "Segment avg revenue intensity",
    "unit": "money",
    "value": 79.3
   },
   {
    "feature": "confident_expected_pickup",
    "label": "Expected pickup (segment)",
    "unit": "ratio",
    "value": 14.5
   },
   {
    "feature": "market_seg_Travel",
    "label": "Travel segment",
    "unit": "flag",
    "value": 3.5
   },
   {
    "feature": "decision_time_days",
    "label": "Days client takes to decide",
    "unit": "count",
    "value": 0.7
   },
   {
    "feature": "response_due_days",
    "label": "Days to respond",
    "unit": "count",
    "value": 0.6
   },
   {
    "feature": "full_day_pct",
    "label": "Full-day meeting share",
    "unit": "ratio",
    "value": 0.4
   }
  ]
 },
 {
  "model": "fnb",
  "title": "F&B spend per person",
  "metric": "share of split gain (%)",
  "kind": "pct",
  "fit": "XGBoost \u00b7 R\u00b2 0.96 \u00b7 error \u00b1$4.68",
  "rows": [
   {
    "feature": "length_of_stay_category_enc",
    "label": "Length-of-stay category (0 short, 1 single, 2 weekend)",
    "unit": "count",
    "value": 33.0
   },
   {
    "feature": "segment_avg_revenue_intensity",
    "label": "Segment avg revenue intensity",
    "unit": "money",
    "value": 26.3
   },
   {
    "feature": "pickup_momentum",
    "label": "Pickup momentum",
    "unit": "ratio",
    "value": 20.4
   },
   {
    "feature": "num_meeting_rooms",
    "label": "Meeting rooms",
    "unit": "count",
    "value": 8.8
   },
   {
    "feature": "full_day_pct",
    "label": "Full-day meeting share",
    "unit": "ratio",
    "value": 7.8
   },
   {
    "feature": "num_fnb_types",
    "label": "F&B types requested",
    "unit": "count",
    "value": 2.4
   }
  ]
 }
];

// Best-effort formatting of a raw feature-vector value for display. These
// are the model's actual training-time inputs, not polished business
// metrics — shown as-is (rounded) with a unit hint, never invented.
function formatFeatureValue(value, unit) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const n = Number(value);
  if (unit === 'flag') return n >= 0.5 ? 'Yes' : 'No';
  if (unit === 'pct') return n.toFixed(0) + '%';
  if (unit === 'money') return safeFmt(n);
  if (unit === 'ratio') return (Math.abs(n) <= 1.5 ? (n * 100).toFixed(0) + '%' : n.toFixed(2));
  if (unit === 'days' || unit === 'count') return Math.round(n).toLocaleString();
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2);
}

// Committed group rooms per night from booked_events, EXCLUDING any booked
// event that is this same RFP (linked by rfp_id, or same arrival date and
// matching account/event name). Without this, an RFP that already appears in
// booked_events would be treated as displacing itself.
function committedRoomsExcluding(rfp, bookedEvents = []) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = [rfp?.organization, rfp?.event_name, rfp?.Account_Name].map(norm).filter(Boolean);
  const arr = String(rfp?.arrival_date || rfp?.Arrival_Date || '').slice(0, 10);
  const map = {};
  for (const ev of bookedEvents) {
    const same = (ev.rfpId && ev.rfpId === rfp?.id) ||
      (ev.arrival === arr && names.some(n => n && (norm(ev.name).includes(n) || n.includes(norm(ev.name)))));
    if (same) continue;
    for (let d = new Date(ev.arrival); d < new Date(ev.departure); d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      if (!map[k]) map[k] = { rooms: 0 };
      map[k].rooms += ev.rooms;
    }
  }
  return map;
}

// Build the three strategy cards from JS XGBoost predictions
function buildJSStrategies(rfp, preds, nights, bookedMap = {}, contract = null) {
  const { baseline_adr, pickup_rate, conversion_prob, fnb_per_person, meeting_space_base, convAt } = preds;
  const baseFnb   = rfp.attendees * fnb_per_person;
  const baseSpace = meeting_space_base;

  // Displacement cost: transient revenue this group displaces, computed per
  // night from transient demand vs. remaining capacity (computeDisplacement
  // in transientDemand.js). Replaces the old linear rule
  // baseline_adr × block × nights × 0.28 × forecasted_occupancy.
  // It depends on dates and block only, not on the strategy's ADR, so it is
  // computed once and shared by all three cards.
  const BASELINE_ADR_DISP = CONFIG_DEFAULTS.baseline_adr;
  const disp = computeDisplacement({
    arrivalDate:   new Date(rfp.arrival_date),
    departureDate: new Date(rfp.departure_date),
    roomBlock:     Number(rfp.room_block) || 0,
    bookedMap,
    totalRooms:    CONFIG_DEFAULTS.total_rooms,
  });

  const make = (name, risk, color, adrMult, pickupMult, convMult, fnbMult, spaceMult, recommended, includes, subtitle) => {
    const adr       = Math.round(baseline_adr * adrMult);
    const pickup    = Math.min(0.99, pickup_rate * pickupMult);
    // Conversion is re-predicted at THIS strategy's price (no hand-set multiplier).
    const conv      = (convAt && convAt(adr)) ?? Math.min(0.99, conversion_prob * convMult);
    const rv        = computeRoomsValue({ adr, pickup, block: Number(rfp.room_block) || 0, nights, dispCost: disp.total, contract, cpor: CONFIG_DEFAULTS.cpor });
    const roomRev   = rv.roomRevenue;
    // Realistic F&B: minimum $35/person for meeting groups, $18 for room-only
    const fnbPPFloor = rfp.has_meeting_space ? 35 : 18;
    const fnbRevRaw  = Math.round(baseFnb * fnbMult);
    const fnbRev     = Math.max(fnbRevRaw, Math.round(fnbPPFloor * (rfp.attendees || rfp.room_block * 1.4) * fnbMult));
    // With a contract, the rental is the contracted charge (full rental × (1 − discount)).
    const hasContractRental = contract && Number(contract.full_meeting_rental) > 0;
    const spaceRev  = hasContractRental ? Math.round(Number(contract.rental_charged) || 0) : Math.round(baseSpace * spaceMult);
    const totalRev  = roomRev + fnbRev + spaceRev;
    // Displacement cost — zero when the hotel has room for group + transient
    const dispCost  = disp.total;
    const netRev    = totalRev - dispCost;
    // Rooms-only value: room revenue − displacement − CPOR cost (no flat margin, no $0 floor).
    // F&B and meeting rental are shown, not valued.
    const profit    = rv.delta;
    const roiPct    = Math.round((netRev / Math.max(1, BASELINE_ADR_DISP * rfp.room_block * nights) - 1) * 100);
    return {
      name, risk, color, adr,
      pickupRate:     Math.round(pickup * 100),
      conversionProb: Math.round(conv * 100),
      gviIndex:       Math.round(totalRev / 1000),
      roomRevenue:    roomRev,
      fnbRevenue:     fnbRev,
      spaceRevenue:   spaceRev,
      rentalFromContract: !!hasContractRental,
      totalRevenue:   totalRev,
      dispCost,
      dispDetail:     disp,
      expectedProfit: profit,
      riskAdjustedValue: Math.round(profit * conv),
      roomCost:       rv.roomCost,
      roiVsBaseline:  (roiPct >= 0 ? '+' : '') + roiPct + '%',
      recommended,
      includes,
      subtitle,
    };
  };

  return [
    make('Conservative Capture', 'Low Risk',    'success', 0.93, 1.08, 1.12, 0.90, 1.00, false,
      ['3 comp rooms', `$30/person F&B credit`, '50% space discount', 'Free WiFi', 'Late checkout', 'Welcome reception'],
      'Select Conservative Strategy'),
    make('Optimal Balance',      'Medium Risk', 'warning', 1.00, 1.00, 1.00, 1.00, 1.40, true,
      ['2 comp rooms', `$25/person F&B credit`, '30% space discount', 'Free WiFi', 'Welcome reception', 'Late checkout'],
      'Select Recommended Strategy'),
    make('Premium Position',     'Higher Risk', 'error',   1.15, 0.94, 0.88, 1.20, 1.70, false,
      ['1 comp room', `$20/person F&B credit`, '15% space discount', 'Free WiFi', 'Welcome amenity'],
      'Select Premium Strategy'),
  ];
}

// ─── MANUAL OVERRIDE SUPPORT ─────────────────────────────────────────────────
// Applies any user-entered overrides on top of a generated strategy and
// recalculates everything that depends on them (Total Revenue is always
// Room + F&B + Space — never directly editable — and Expected Profit /
// Risk-Adjusted Value / ROI / Deal Score stay in sync with it).
const OVERRIDE_FIELDS = ['adr', 'pickupRate', 'conversionProb', 'roomRevenue', 'fnbRevenue', 'spaceRevenue'];

function applyStrategyOverrides(strategy, override, rfp, nights, contract = null) {
  if (!override) return strategy;
  const adr             = override.adr            ?? strategy.adr;
  const pickupRate      = override.pickupRate      ?? strategy.pickupRate;
  const conversionProb  = override.conversionProb  ?? strategy.conversionProb;
  const fnbRevenue      = override.fnbRevenue      ?? strategy.fnbRevenue;
  const spaceRevenue    = override.spaceRevenue    ?? strategy.spaceRevenue;

  // Room Revenue is mechanically ADR × Pickup × room-nights — it recalculates
  // automatically whenever ADR or Pickup % change. Editing Room Revenue itself
  // pins it directly, until ADR or Pickup are touched again (see updateOverride,
  // which clears this pin so the two never silently disagree).
  const roomNights  = (Number(rfp?.room_block) || 0) * (nights || 1);
  const roomRevenue = override.roomRevenue !== undefined
    ? override.roomRevenue
    : Math.round(adr * roomNights * (pickupRate / 100));

  const totalRevenue    = roomRevenue + fnbRevenue + spaceRevenue;

  // dispCost is occupancy-driven, not strategy-specific, so it's left as-is.
  const dispCost   = strategy.dispCost || 0;
  const netRev     = totalRevenue - dispCost;
  const rv = computeRoomsValue({ adr, pickup: pickupRate / 100, block: Number(rfp?.room_block) || 0, nights: nights || 1,
    dispCost, contract, cpor: CONFIG_DEFAULTS.cpor, pinnedRoomRevenue: override.roomRevenue });
  const expectedProfit = rv.delta;
  const riskAdjustedValue = Math.round(expectedProfit * (conversionProb / 100));
  const baselineDenom = Math.max(1, 164 * roomNights);
  const roiPct = Math.round((netRev / baselineDenom - 1) * 100);
  const roiVsBaseline = (roiPct >= 0 ? '+' : '') + roiPct + '%';
  const gviIndex = Math.round(totalRevenue / 1000);

  return {
    ...strategy,
    adr, pickupRate, conversionProb, roomRevenue, fnbRevenue, spaceRevenue,
    totalRevenue, dispCost, expectedProfit, riskAdjustedValue, roiVsBaseline, gviIndex,
    overridden: OVERRIDE_FIELDS.some(f => override[f] !== undefined),
  };
}

// ─── MAIN STRATEGIES VIEW ────────────────────────────────────────────────────

const StrategiesView = ({ rfp, onBack, onEdit, onRfpChange, inEditMode = false, contract = null }) => {
  const [strategies, setStrategies] = useState(null);
  const [selectedStrategyName, setSelectedStrategyName] = useState(rfp?.selected_strategy || null);
  const [predictions, setPredictions] = useState(null);
  // Starts true: nothing renders until a real model prediction (JS XGBoost
  // trees or the Pyodide/pkl path) actually returns. No rule-based/guessed
  // numbers are ever shown in the meantime — see the loading/error states
  // in the render below.
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modelStatus, setModelStatus] = useState('Loading model predictions…');
  const [activeTab, setActiveTab] = useState('strategies');
  const [xgbStatus, setXgbStatus] = useState('idle'); // idle | loading | loaded | failed

  // Manual overrides for strategy numbers, keyed by strategy name.
  const [overrides, setOverrides] = useState({});
  useEffect(() => { setOverrides({}); }, [rfp?.id]);

  // Kim's "Recommended vs. Quoted vs. Booked" outcome tracking — kept on the
  // RFP doc for future model comparison/learning, per her UX Revision Master.
  const [actualQuoted, setActualQuoted] = useState(rfp.actual_quoted_adr ?? '');
  const [actualBooked, setActualBooked] = useState(rfp.actual_booked_adr ?? '');
  const [actualsSaved, setActualsSaved] = useState(true);
  useEffect(() => {
    setActualQuoted(rfp.actual_quoted_adr ?? '');
    setActualBooked(rfp.actual_booked_adr ?? '');
    setActualsSaved(true);
  }, [rfp?.id]);
  const saveActuals = async () => {
    try {
      const col = rfp._col || 'rfps';
      await updateDoc(doc(db, col, rfp.id), {
        actual_quoted_adr: actualQuoted === '' ? null : Number(actualQuoted),
        actual_booked_adr: actualBooked === '' ? null : Number(actualBooked),
      });
      setActualsSaved(true);
      if (onRfpChange) onRfpChange({ ...rfp, actual_quoted_adr: actualQuoted === '' ? null : Number(actualQuoted), actual_booked_adr: actualBooked === '' ? null : Number(actualBooked) });
    } catch (e) {
      console.warn('Could not save actual quoted/booked rate:', e);
    }
  };

  // Primary strategy view is Kim's "one unified recommendation" — the
  // 3-tier comparison grid and full analytics panel were removed from this
  // screen (see the render below); primaryStrategy still drives everything
  // shown here.
  const updateOverride = (strategyName, field, rawValue) => {
    const num = rawValue === '' ? undefined : Number(rawValue);
    const clean = (num === undefined || isNaN(num)) ? undefined : num;
    setOverrides(prev => {
      const next = { ...prev[strategyName], [field]: clean };
      // Room Revenue = ADR × Pickup × room-nights. If ADR or Pickup change,
      // drop any pinned Room Revenue so it re-derives from the new numbers
      // instead of silently going stale.
      if (field === 'adr' || field === 'pickupRate') {
        delete next.roomRevenue;
      }
      return { ...prev, [strategyName]: next };
    });
  };

  const demandEvents = useDemandEvents(rfp);
  const topDemand = demandEvents.reduce((top, ev) => {
    const order = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    return !top || (order[ev.impact] || 0) > (order[top.impact] || 0) ? ev : top;
  }, null);

  const handleSelectStrategy = async (strategy) => {
    setSelectedStrategyName(strategy.name);
    try {
      const col = rfp._col || 'rfps';
      await updateDoc(doc(db, col, rfp.id), {
        selected_strategy: strategy.name,
        selected_adr: strategy.adr,
        selected_pickup_rate: strategy.pickupRate,
        selected_conversion_prob: strategy.conversionProb,
        selected_room_revenue: strategy.roomRevenue,
        selected_fnb_revenue: strategy.fnbRevenue,
        selected_space_revenue: strategy.spaceRevenue,
        selected_total_revenue: strategy.totalRevenue,
        selected_expected_profit: strategy.expectedProfit,
        selected_manually_overridden: !!strategy.overridden,
        selected_at: serverTimestamp(),
        // Status vocabulary: 'new' | 'definite' | 'declined' — selecting a
        // strategy does NOT itself change status (that's what makes an
        // otherwise-'new' RFP display as "Tentative" on the dashboard, via
        // the presence of selected_strategy). Only fill in a default if the
        // RFP somehow has no status at all yet.
        status: rfp.status || 'new',
      });
      if (onRfpChange) onRfpChange({ ...rfp, selected_strategy: strategy.name });
    } catch (e) {
      console.warn('Could not save strategy selection:', e);
    }
  };

  const config = CONFIG_DEFAULTS;

  // buildModelFeatures needs the same live booked_events/rfps/incoming_rfps
  // data RankingView.jsx already has via its onSnapshot listeners — but this
  // view only ever receives a single `rfp` prop, so it fetches its own
  // one-time snapshot here rather than leaving those features silently at 0.
  const [modelCtx, setModelCtx] = useState({ bookedMap: {}, bookedEvents: [], allRfps: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bookedSnap, rfpsSnap, incomingSnap] = await Promise.all([
          getDocs(collection(db, 'booked_events')),
          getDocs(collection(db, 'rfps')),
          getDocs(collection(db, 'incoming_rfps')),
        ]);
        const bookedMap = {};
        const bookedEvents = [];
        bookedSnap.docs.forEach(d => {
          const ev = d.data();
          const arr = ev.Arrival_Date || ev.arrival_date;
          const dep = ev.Departure_Date || ev.departure_date;
          if (!arr || !dep) return;
          const rooms = Number(ev.Peak_Room_Block || ev.room_block || 0);
          const bal   = Number(ev.Uses_Ballroom   || ev.uses_ballroom   || 0);
          bookedEvents.push({
            id: d.id, rfpId: ev.rfp_id || ev.source_rfp_id || null,
            name: String(ev.Account_Name || ev.organization || ev.event_name || ''),
            arrival: String(arr).slice(0, 10), departure: String(dep).slice(0, 10), rooms,
          });
          for (let d2 = new Date(arr); d2 < new Date(dep); d2.setDate(d2.getDate() + 1)) {
            const k = d2.toISOString().slice(0, 10);
            if (!bookedMap[k]) bookedMap[k] = { rooms: 0, ballroom: false };
            bookedMap[k].rooms += rooms;
            if (bal) bookedMap[k].ballroom = true;
          }
        });
        const seen = new Set();
        const allRfps = [
          ...rfpsSnap.docs.map(d => ({ id: d.id, _col: 'rfps', ...d.data() })),
          ...incomingSnap.docs.map(d => ({ id: d.id, _col: 'incoming_rfps', ...d.data() })),
        ].filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
        if (!cancelled) setModelCtx({ bookedMap, bookedEvents, allRfps, loaded: true });
      } catch (e) {
        console.warn('Could not load booked/RFP data for model features — falling back to RFP-only features:', e);
        if (!cancelled) setModelCtx({ bookedMap: {}, bookedEvents: [], allRfps: [], loaded: true });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const nights = (() => {
    const arr = new Date(rfp.arrival_date || rfp.Arrival_Date);
    const dep = new Date(rfp.departure_date || rfp.Departure_Date);
    const n = Math.ceil((dep - arr) / (1000 * 60 * 60 * 24));
    return isNaN(n) || n <= 0 ? 1 : n;
  })();

  // Try XGBoost once the account-history/booking-conflict data has loaded
  // (or immediately with empty context, if that fetch failed) — re-runs if
  // the selected RFP changes. There is deliberately no instant rule-based
  // placeholder here: the screen stays in a loading state (see the render
  // below) until a real model prediction lands, and shows an honest error
  // state if neither model path can produce one. No invented numbers.
  useEffect(() => {
    if (!modelCtx.loaded) return;
    setIsLoading(true);
    setModelStatus('Loading model predictions…');
    tryXGBoost();
  }, [modelCtx, rfp?.id]);

  const tryXGBoost = async () => {
    setXgbStatus('loading');

    // ── Path 1: JS trees (pickup_ipw) — instant, no Pyodide ──────────────────
    if (XGBOOST_TREES?.pickup_ipw) {
      try {
        const preds = runJSXGBoost(rfp, config, modelCtx);
        setPredictions(preds);
        setStrategies(buildJSStrategies(rfp, preds, nights, committedRoomsExcluding(rfp, modelCtx.bookedEvents), contract));
        setModelStatus('XGBoost JS trees · pickup_ipw (IPW-corrected)');
        setXgbStatus('loaded');
        setIsLoading(false);
        return;
      } catch (err) {
        console.warn('JS XGBoost failed, trying Pyodide:', err.message);
      }
    }

    // ── Path 2: Pyodide + pkl — same trained models, legacy runtime ─────────
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000));
      const load = (async () => {
        await initPyodide();
        await loadModel('/rfp_xgboost_models_compatible.pkl');
        return await predictStrategies(rfp);
      })();

      const result = await Promise.race([load, timeout]);

      if (result.success) {
        setStrategies(result.strategies);
        const optimal = result.strategies.find(s => s.recommended) || result.strategies[1] || result.strategies[0];
        setPredictions({
          baseline_adr: optimal.adr,
          pickup_rate: optimal.pickupRate / 100,
          conversion_prob: optimal.conversionProb / 100,
          // Derived from this model run's own revenue output, not a guessed
          // constant — the ?? 0 guard only prevents a NaN on a malformed
          // RFP (zero nights/attendees), it never stands in for a missing
          // prediction.
          fnb_per_person: (nights > 0 && rfp.attendees > 0) ? Math.round(optimal.fnbRevenue / (rfp.attendees * nights)) : null,
          room_nights: rfp.room_block * nights,
          meeting_space_base: 8000,
        });
        setModelStatus(`XGBoost predictions (${result.prediction_method})`);
        setXgbStatus('loaded');
        setIsLoading(false);
      } else {
        throw new Error('Prediction failed');
      }
    } catch (err) {
      console.warn('XGBoost unavailable — no fallback numbers will be shown:', err.message);
      setXgbStatus('failed');
      setError(err.message || 'Model prediction unavailable');
      setIsLoading(false);
    }
  };

  const allStrategies = strategies || null;
  // Same overrides the cards use, applied once so the panel below (walk-away
  // risk, Pareto efficiency, etc.) reflects edited numbers instead of the
  // original model output.
  const liveStrategies = allStrategies
    ? allStrategies.map(s => applyStrategyOverrides(s, overrides[s.name], rfp, nights, contract))
    : null;
  // No fallback here either — the negotiate tab (below) only mounts
  // NegotiationPanel once real predictions exist.
  const activePredictions = predictions;

  // The single unified recommendation Kim's redesign calls for. Nothing is
  // lost — this is the same "Optimal Balance" strategy object the 3-tier
  // grid below still shows, including its live overrides; it's just
  // surfaced as one number instead of one of three equal-weight cards.
  const primaryStrategy = liveStrategies
    ? (liveStrategies.find(s => s.recommended) || liveStrategies[1] || liveStrategies[0])
    : null;

  // Real feature vector this RFP produced, captured off the live XGBoost run
  // (see runJSXGBoost's `_bf`). Null until that run completes — the
  // significant-features panel shows a loading state rather than guessing.
  const rfpFeatureVector = predictions?._bf || null;

  return (
    <div className="strategies-container">
      {/* Top bar */}
      <div className="strategies-top-bar">
        {!inEditMode && <button onClick={onBack} className="btn-back"><ArrowLeft size={16} /> Edit RFP</button>}


      </div>

      
      

      {/* RFP Summary */}
      <div className="rfp-summary-bar">
        <h2 className="rfp-summary-title">{rfp.event_name}</h2>
        <p className="rfp-summary-dates">
          {new Date(rfp.arrival_date).toLocaleDateString()} – {new Date(rfp.departure_date).toLocaleDateString()} ({nights} nights)
        </p>
        <div className="rfp-summary-stats">
          <div className="rfp-stat-chip"><span className="rfp-stat-label">Attendees</span><span className="rfp-stat-value">{rfp.attendees}</span></div>
          <div className="rfp-stat-chip"><span className="rfp-stat-label">Room Block</span><span className="rfp-stat-value">{rfp.room_block}</span></div>
          <div className="rfp-stat-chip"><span className="rfp-stat-label">Client Priority</span><span className="rfp-stat-value">{rfp.client_priority}</span></div>
        </div>
      </div>

      {/* STRATEGIES TAB */}
      {activeTab === 'strategies' && (
        <>
          <h3 className="strategies-section-title">Recommended Pricing Strategies</h3>
          <p className="strategies-section-subtitle">
            The <span style={{ color: '#5b5fc7', fontWeight: 600 }}>highlighted option</span> is recommended based on current market conditions.
          </p>

          {isLoading ? (
            <div className="strategies-loading"><RefreshCw className="spin" size={48} /><p>{modelStatus}</p></div>
          ) : !predictions ? (
            <div className="model-error-card">
              <div className="model-error-title">⚠ Model prediction unavailable</div>
              <div className="model-error-note">
                MERIT could not get a real prediction for this RFP from either model runtime (XGBoost JS trees or the Pyodide/pkl path).
                No rule-based or estimated numbers are shown in place of it — that would misrepresent them as model output.
                {error ? <> Last error: <code>{error}</code>.</> : null}
              </div>
              <button className="btn-strategy" onClick={tryXGBoost}>Retry</button>
            </div>
          ) : (
            <div>
          {topDemand && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem',
              background: (DEMAND_COLORS[topDemand.impact] || '#f97316') + '15',
              border: `1px solid ${DEMAND_COLORS[topDemand.impact] || '#f97316'}`,
              borderRadius: '8px', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '1.2rem' }}>⚡</span>
              <div>
                <div style={{ fontWeight: 700, color: DEMAND_COLORS[topDemand.impact], marginBottom: '0.2rem' }}>
                  {topDemand.impact} Demand Period: {topDemand.name}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#6b7280' }}>
                  {topDemand.type} · {topDemand.attendance_size} · {topDemand.start_date} – {topDemand.end_date}
                </div>
                {topDemand.notes && <div style={{ fontSize: '0.75rem', color: '#92400e', marginTop: '0.2rem', fontStyle: 'italic' }}>{topDemand.notes}</div>}
                <div style={{ fontSize: '0.75rem', fontWeight: 600, marginTop: '0.35rem', color: DEMAND_COLORS[topDemand.impact] }}>
                  {topDemand.impact === 'Critical' && '→ City fully compressed. Decline low-value groups. Use Premium Position.'}
                  {topDemand.impact === 'High' && '→ Heavy compression. Premium Position recommended — transient demand supports higher ADR.'}
                  {topDemand.impact === 'Medium' && '→ Moderate compression. Consider upgrading to Optimal Balance or Premium.'}
                  {topDemand.impact === 'Low' && '→ Minor demand uplift. Standard recommendation applies.'}
                </div>
              </div>
            </div>
          )}

          {primaryStrategy && (() => {
            const ps = primaryStrategy;
            const gvi = ps.gviIndex;
            const tier = gvi >= 220 ? { label: '🏆 Premium Opportunity', color: '#7c3aed' }
                       : gvi >= 150 ? { label: '⭐ Strong Deal',  color: '#1d4ed8' }
                       :              { label: 'Standard',   color: '#6b7280' };
            const overridden = overrides[ps.name] && Object.values(overrides[ps.name]).some(v => v !== undefined);
            return (
              <div className="merit-reco-card">
                <div className="merit-reco-eyebrow">✦ MERIT RECOMMENDATION{ps.negotiated ? ' — NEGOTIATED' : ''}
                  <InfoTip title="How the recommendation is built">
                    The price is the ADR model's output for this stay's dates, multiplied by the strategy factor (Conservative ×0.93, Optimal ×1.00, Premium ×1.15). The card shows the Optimal strategy. Deal Score is group revenue ÷ $1,000: 220+ Premium, 150+ Strong, otherwise Standard. Win and pickup probabilities come from the two models below. You can type over any number; everything that depends on it recalculates.
                  </InfoTip>
                </div>
                <div className="merit-reco-price-row">
                  <span className="merit-reco-dollar">$</span>
                  <input
                    type="number"
                    className="strategy-num-input merit-reco-input"
                    value={ps.adr}
                    onChange={(e) => updateOverride(ps.name, 'adr', e.target.value)}
                  />
                  <span className="merit-reco-unit">/ night, Group ADR</span>
                </div>
                <div className="merit-reco-note">Decision support only — MERIT (the hotel) makes the final commercial call.</div>
                <ul className="merit-reco-reasons">
                  <li>Based on {ps.name} tier — {ps.risk}, Deal Score <strong style={{ color: tier.color }}>{tier.label}</strong></li>
                  <li>Win probability {ps.conversionProb}% · Pickup probability {ps.pickupRate}%</li>
                  {ps.dispDetail && (ps.dispDetail.displacedRoomNights > 0
                    ? <li>Displaces about {ps.dispDetail.displacedRoomNights} transient room-night{ps.dispDetail.displacedRoomNights === 1 ? '' : 's'} (≈ ${ps.dispDetail.total.toLocaleString()} transient revenue){ps.dispDetail.isModeled ? ' — based on modeled transient demand (2025 backtest ±14 rooms)' : ps.dispDetail.isProxy ? ' — based on estimated transient demand' : ''}</li>
                    : <li>No transient displacement expected — the hotel has room for this group and forecast transient demand{ps.dispDetail.isModeled ? ' (modeled from 2023–25 history)' : ps.dispDetail.isProxy ? ' (estimated)' : ''}</li>)}
                  {topDemand && <li>{topDemand.impact} demand period detected ({topDemand.name}) — factored into this ADR</li>}
                  {overridden && <li style={{ color: '#b45309' }}>✎ Manually overridden from the model's raw output</li>}
                </ul>
              </div>
            );
          })()}

          {primaryStrategy && primaryStrategy.dispDetail && (
            <>
              <DisplacementByNight disp={primaryStrategy.dispDetail} block={Number(rfp.room_block) || 0} totalRooms={CONFIG_DEFAULTS.total_rooms} />
              <PerturbationPanel disp={primaryStrategy.dispDetail} block={Number(rfp.room_block) || 0} delta={primaryStrategy.expectedProfit} ps={primaryStrategy} />
              <KeyFactors ps={primaryStrategy} disp={primaryStrategy.dispDetail} contract={contract} topDemand={topDemand} />
            </>
          )}

          {/* Model Outputs — the four real deployed models, fully represented.
              Everything else on this screen (space revenue, displacement cost,
              profit margin, ROI) is business logic built on top of these four
              numbers, not a separate model output. */}
          <div className="model-outputs-strip">
            <div className="model-outputs-title">Model Outputs</div>
            <div className="model-outputs-grid">
              <div className="model-output-tile">
                <div className="model-output-key">quoted_adr</div>
                <div className="model-output-val">${Math.round(predictions.baseline_adr).toLocaleString()}</div>
                <div className="model-output-label">Predicted ADR<InfoTip title="Predicted ADR">XGBoost model with 15 calendar and market inputs (month demand, transient rate on the stay nights, season, sold-out date, day of week and similar). It was retrained without price-derived inputs, so it prices by date and market only: group size, event type and meeting space do not change it. Test error ±$6.32 on simulated data.</InfoTip></div>
              </div>
              <div className="model-output-tile">
                <div className="model-output-key">pickup_ipw</div>
                <div className="model-output-val">{Math.round(predictions.pickup_rate * 100)}%</div>
                <div className="model-output-label">Pickup Probability<InfoTip title="Pickup probability">XGBoost model with 10 inputs, mainly the segment's average revenue intensity and expected pickup. It estimates the share of the room block that actually shows up. Revenue uses this share of the block. Strategy factors: Conservative ×1.08, Optimal ×1.00, Premium ×0.94 (capped at 99%). R² 0.83, error ±0.043.</InfoTip></div>
              </div>
              <div className="model-output-tile">
                <div className="model-output-key">conversion</div>
                <div className="model-output-val">{Math.round(predictions.conversion_prob * 100)}%</div>
                <div className="model-output-label">Conversion Probability<InfoTip title="Conversion probability">Logistic regression with 16 inputs. Each input is standardised (value minus its training average, divided by its spread), multiplied by its weight and summed with an intercept; the sum is turned into a probability with 1 ÷ (1 + e^−sum). Biggest drivers: rooms already booked, transient guests turned away, forecast occupancy. It has no price input because the training data shows no link between price and winning, so all three strategies share it. Cross-validated AUC 0.76.</InfoTip></div>
              </div>
              <div className="model-output-tile">
                <div className="model-output-key">fnb</div>
                <div className="model-output-val">{predictions.fnb_per_person == null ? '—' : `$${Math.round(predictions.fnb_per_person).toLocaleString()}`}</div>
                <div className="model-output-label">F&amp;B per Person<InfoTip title="F&B per person">XGBoost model with 10 inputs (length-of-stay category, segment revenue intensity, pickup momentum, meeting rooms and others). F&B revenue = per-person spend × attendees × strategy factor (Conservative ×0.90, Optimal ×1.00, Premium ×1.20), with a floor of $35 per person when meeting space is requested and $18 otherwise. Shown beside the rooms value, not part of it. R² 0.96, error ±$4.68.</InfoTip></div>
              </div>
            </div>
            <div className="model-outputs-status">{modelStatus}</div>
          </div>

          {primaryStrategy && (
            <div className="revenue-tiles-grid">
              <div className="revenue-tile"><div className="revenue-tile-label">Group Room Revenue<InfoTip title="Group room revenue">ADR × recognized room-nights. Recognized room-nights = block × nights × expected pickup. With a contract, it is at least the guaranteed room-nights, because attrition is billed. Without a contract, only expected pickup counts.</InfoTip></div><div className="revenue-tile-val">{safeFmt(primaryStrategy.roomRevenue)}</div></div>
              <div className="revenue-tile"><div className="revenue-tile-label">− Displaced transient − room cost (CPOR $50, placeholder)<InfoTip title="Displacement and room cost">Per night: displaced rooms = the smaller of the block, the transient demand, and (block + demand − rooms left after other groups). That is averaged over low, median and high demand (weights 0.3, 0.4, 0.3) and multiplied by the transient rate. Room cost = $50 cost per occupied room × occupied room-nights. The $50 is a placeholder until the hotel supplies its real figure.</InfoTip></div><div className="revenue-tile-val">{safeFmt((primaryStrategy.dispCost || 0) + (primaryStrategy.roomCost || 0))}</div></div>
              <div className="revenue-tile revenue-tile-total"><div className="revenue-tile-label">Rooms value (Δ, before conversion)<InfoTip title="Rooms value (Δ)">Group room revenue − displaced transient revenue − cost of occupied rooms − contract concessions. It is not floored at zero, so a negative number means the booking loses money against holding the rooms for transient guests. Multiply by the win probability for a risk-adjusted value. F&B and meeting rental are not included.</InfoTip></div><div className="revenue-tile-val">{Number(primaryStrategy.expectedProfit) < 0 ? '−' : ''}{safeFmt(Math.abs(primaryStrategy.expectedProfit))}</div></div>
              <div className="revenue-tile"><div className="revenue-tile-label">F&amp;B Revenue (shown, not valued)<InfoTip title="F&B revenue">F&B per person (model) × attendees × strategy factor, with the per-person floor described under the F&B model. Shown for context only; it does not change the rooms value.</InfoTip></div><div className="revenue-tile-val">{safeFmt(primaryStrategy.fnbRevenue)}</div></div>
              <div className="revenue-tile"><div className="revenue-tile-label">{primaryStrategy.rentalFromContract ? 'Rental charged (contract)' : 'Meeting Rental (placeholder, shown not valued)'}<InfoTip title="Meeting rental">{primaryStrategy.rentalFromContract ? 'From the contract: full meeting rental × (1 − rental discount). Shown for context; it does not change the rooms value.' : 'A placeholder: room block × nights × the meeting rate in hotelConfig.js ($18 per room-night) × strategy factor (Conservative ×1.00, Optimal ×1.40, Premium ×1.70). Not a model output. Enter a contract with the full meeting rental to replace it with the real charge.'}</InfoTip></div><div className="revenue-tile-val">{safeFmt(primaryStrategy.spaceRevenue)}</div>{primaryStrategy.rentalFromContract && <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 4 }}>Full rental {safeFmt(contract.full_meeting_rental)} − {Number(contract.rental_discount_pct) || 0}% discount{Number(contract.fnb_minimum) > 0 ? ` · F&B minimum ${safeFmt(contract.fnb_minimum)}` : ''}</div>}</div>
            </div>
          )}

          {/* Track the outcome — Kim's Recommended vs. Quoted vs. Booked spec,
              kept on the RFP doc for future model comparison/learning. */}
          {primaryStrategy && (
            <div className="outcome-track-card">
              <div className="outcome-track-title">Track the outcome</div>
              <div className="outcome-track-note">Kept for comparison against what's actually quoted and booked — the basis for future model learning.</div>
              <div className="outcome-track-grid">
                <div className="outcome-track-col outcome-track-col-reco">
                  <div className="outcome-track-label">MERIT Recommended</div>
                  <div className="outcome-track-val">${primaryStrategy.adr.toLocaleString()}</div>
                </div>
                <div className="outcome-track-col">
                  <div className="outcome-track-label">Actually Quoted</div>
                  <input type="number" placeholder="Enter quoted rate…" value={actualQuoted}
                    onChange={(e) => { setActualQuoted(e.target.value); setActualsSaved(false); }} />
                </div>
                <div className="outcome-track-col">
                  <div className="outcome-track-label">Ultimately Booked</div>
                  <input type="number" placeholder="Enter booked rate…" value={actualBooked}
                    onChange={(e) => { setActualBooked(e.target.value); setActualsSaved(false); }} />
                </div>
              </div>
              {!actualsSaved && (
                <button className="btn-strategy" style={{ marginTop: '0.75rem', padding: '0.5rem 1.25rem' }} onClick={saveActuals}>Save</button>
              )}
            </div>
          )}

          {/* Most significant features for THIS RFP — global importance from
              the four trained models' feature_importance exports, values from
              this RFP's own live feature vector. Not SHAP/per-instance
              attribution (that would need the model object in-browser) — an
              honest approximation, labeled as such. */}
          <div className="feature-sig-card">
            <div className="feature-sig-title">What's driving this recommendation<InfoTip title="Importance lists">Each list is one model's own importance ranking. ADR: average absolute SHAP effect in dollars. Conversion: standardised logistic weights (positive raises the win chance). Pickup and F&B: share of tree-split gain. The value on the right is this RFP's own input. These are global importances, not a per-RFP explanation.</InfoTip></div>
            <div className="feature-sig-note">
              The inputs each current model relies on most, shown against this RFP's own values. These are global
              importances, not per-prediction explanations: they show what matters most to each model in general.
              Orange bars lower the win chance. Models were trained on simulated data.
            </div>
            {!rfpFeatureVector ? (
              <div style={{ fontSize: '0.8125rem', color: '#94a3b8', padding: '0.5rem 0' }}>Loading model feature vector…</div>
            ) : (
              FEATURE_GROUPS.map(g => {
                const maxAbs = Math.max(...g.rows.map(r => Math.abs(r.value))) || 1;
                return (
                  <div key={g.model} style={{ marginTop: '1.1rem' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{g.title}</div>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.35rem' }}>{g.fit} · bars: {g.metric}</div>
                    <div className="feature-sig-list">
                      {g.rows.map(f => {
                        const val = rfpFeatureVector[f.feature];
                        const barPct = Math.min(100, (Math.abs(f.value) / maxAbs) * 100);
                        const shown = g.kind === 'dollars' ? '$' + f.value.toFixed(1) : g.kind === 'signed' ? (f.value > 0 ? '+' : '−') + Math.abs(f.value).toFixed(2) : f.value.toFixed(1) + '%';
                        return (
                          <div key={f.feature} className="feature-sig-row">
                            <div className="feature-sig-label">{f.label}</div>
                            <div className="feature-sig-bar-track"><div className="feature-sig-bar-fill" style={{ width: barPct + '%', background: g.kind === 'signed' && f.value < 0 ? '#c0623a' : undefined }} /></div>
                            <div className="feature-sig-pct">{shown}</div>
                            <div className="feature-sig-thisrfp">{formatFeatureValue(val, f.unit)}</div>
                            {f.note && <div className="feature-sig-flag">⚠ {f.note}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* The 3-tier comparison grid and full StrategyJustification
              analytics panel that used to live here (behind a "Compare all
              pricing tiers" toggle) have been removed from this screen per
              explicit request — Kim's single-recommendation view above,
              plus the Model Outputs strip and feature-significance panel,
              is the whole primary screen now. The underlying data
              (allStrategies/liveStrategies/primaryStrategy) is untouched
              and still drives the MERIT Recommendation card above; only
              this comparison UI was deleted. */}
      </div>
          )}
        </>
      )}
    </div>
  );
};

export default StrategiesView;
