
/**
 * modelFeatures.js
 *
 * Builds the feature vector that xgboost_trees_data_v7.js actually expects.
 *
 * Why this file exists: the real trained model's `f` list (checked directly
 * against xgboost_trees_data_v7.js) uses ~70 distinct feature names across
 * the six trees (quoted_adr, conversion, pickup_uncorr, pickup_ipw,
 * pickup_heckman, fnb). The feature dicts previously built inline in
 * RankingView.jsx and StrategiesView.jsx used a different, hand-invented set
 * of ~38 key names (a mix of report terminology and guesses) that barely
 * overlaps with what the model was actually trained on — only 13 of the 70
 * names matched. Every unmatched feature silently defaulted to 0 inside
 * xgbPredict() (`dict[f] ?? 0`), so most predictions were effectively being
 * computed from a mostly-empty input vector while still being labeled
 * "XGBoost predicted" in the UI.
 *
 * v2 update: with the real training pipeline (rfp_xgboost_pipeline_v7_1.py),
 * the real training data (rfp_training_data_complete_v3.csv), and the real
 * transient-demand calendar (Nexus_Transient_Demand_v2.csv) now available,
 * several encodings that were previously best-effort guesses have been
 * corrected against the actual pipeline source (event_type, lead_source,
 * group_size_tier thresholds, is_shoulder_season), and the transient/
 * rolling-window features that used to be hardcoded 0 are now computed from
 * the real calendar via transientDemand.js — exactly, where the pipeline's
 * own join logic is fully known, and via a documented, labeled approximation
 * where the training-time formula itself was never provided to us (see
 * transientDemand.js's header for the exact/approximate/unknown breakdown).
 * A handful of composites (capacity_risk_score, revenue_intensity,
 * tactical_compression_opportunity) still have no formula anywhere in the
 * provided materials and are left at 0 rather than invented.
 */
 
import { buildTransientFeatures } from './transientDemand';
 
// ── Label encodings (must match the training-time encodings described in
// the report, Section 4.1, where known; otherwise a reasonable ordering) ──
 
const EVENT_FORMAT_ENC = { 'Hybrid': 0, 'In-person': 1, 'Virtual': 2 };
 
// Verified against the real training pipeline: `pd.Categorical(ev[c]).codes`
// assigns codes in sorted-alphabetical order of the categories actually
// present in rfp_training_data_complete_v3.csv. There is NO 'Tour/Travel'
// category in the real training data at all — RFPFormView.jsx offers it as a
// dropdown option, but the trained model never saw it, so any RFP with that
// event_type necessarily falls outside what the model can meaningfully score
// (it will encode to 0, colliding with 'Association' — a real, unavoidable
// blind spot in the model itself, not a bug in this file).
const EVENT_TYPE_ENC = { 'Association': 0, 'Corporate': 1, 'SMERF': 2, 'Wedding/Social': 3 };
 
// Verified against the real training pipeline the same way (alphabetical
// pd.Categorical codes over the real distinct lead_source values).
const LEAD_SOURCE_ENC = {
  'Cvent': 0, 'Direct Inquiry': 1, 'RFP': 2, 'Referral': 3,
  'Repeat Client': 4, 'Sales Call': 5, 'Third-Party Planner': 6, 'Website': 7,
};
 
// One-hot columns actually present in the trained model (from
// xgboost_trees_data_v7.js). Note the RFPFormView dropdown offers a few
// segments — "Non-Profit", "Real Estate" — that have NO corresponding
// one-hot column here. Those selections (and "Corporate", the implicit
// dropped reference level) all correctly encode as all-zero; that's not a
// bug in this file, it's a mismatch between the form's option list and the
// segments the model was actually trained on.
const MARKET_SEGMENTS = [
  'Association', 'Education', 'Finance', 'Government', 'Healthcare', 'Legal',
  'Other', 'Professional Services', 'SMERF', 'Social', 'Technology',
  'Trade/Manufacturing', 'Travel',
];
 
// Verified against rfp_xgboost_pipeline_v7_1.py (FIX 2, `group_size_tier`
// column, size_order mapping): small=0 (5-19 rooms), medium=1 (20-49),
// large=2 (50-99), very_large=3 (100+). room_block===0 (meeting-only) is
// handled separately via the `is_meeting_only` flag, matching the pipeline's
// own extraction of that case before this ordinal encoding is applied.
function groupSizeTierEnc(roomBlock) {
  if (roomBlock <= 0) return 0; // is_meeting_only handled as its own flag
  if (roomBlock < 20) return 0;  // small: 5-19
  if (roomBlock < 50) return 1;  // medium: 20-49
  if (roomBlock < 100) return 2; // large: 50-99
  return 3;                      // very_large: 100+
}
 
const sinAngle = (x, period) => Math.sin(2 * Math.PI * x / period);
const cosAngle = (x, period) => Math.cos(2 * Math.PI * x / period);
 
/**
 * Cheap account-history lookup from an already-fetched list of RFPs
 * (rfps + incoming_rfps merged). Matches on organization name, falling back
 * to contact email. This is a real but simple computation — not a
 * time-series feature — so it's reasonable to compute inline rather than
 * mark it "unavailable".
 */
function accountHistory(rfp, allRfps) {
  if (!Array.isArray(allRfps) || allRfps.length === 0) {
    return { priorBooked: 0, priorRevenue: 0, isRepeat: 0, daysSinceLastRfp: 999 };
  }
  const org = (rfp.organization || rfp.Organization || '').trim().toLowerCase();
  const email = (rfp.contact_email || rfp.Contact_Email || '').trim().toLowerCase();
  if (!org && !email) return { priorBooked: 0, priorRevenue: 0, isRepeat: 0, daysSinceLastRfp: 999 };
 
  const inquiryDate = new Date(rfp.inquiry_date || rfp.Inquiry_Date || Date.now());
  let priorBooked = 0;
  let priorRevenue = 0;
  let mostRecentPriorMs = null;
 
  allRfps.forEach(other => {
    if (other.id === rfp.id) return;
    const otherOrg = (other.organization || other.Organization || '').trim().toLowerCase();
    const otherEmail = (other.contact_email || other.Contact_Email || '').trim().toLowerCase();
    const sameAccount = (org && otherOrg === org) || (email && otherEmail === email);
    if (!sameAccount) return;
 
    const otherInquiry = new Date(other.inquiry_date || other.Inquiry_Date || 0);
    if (!isNaN(otherInquiry) && otherInquiry < inquiryDate) {
      if (mostRecentPriorMs === null || otherInquiry.getTime() > mostRecentPriorMs) {
        mostRecentPriorMs = otherInquiry.getTime();
      }
    }
 
    const status = (other.status || other.Status || '').toLowerCase();
    if (status === 'approved' || status === 'won') {
      priorBooked += 1;
      const rooms  = Number(other.room_block || other.Peak_Room_Block || 0);
      const rate   = Number(other.quoted_adr  || other.Quoted_ADR     || 0) || 164 * 0.88;
      priorRevenue += rooms * rate;
    }
  });
 
  const daysSinceLastRfp = mostRecentPriorMs !== null
    ? Math.max(0, Math.round((inquiryDate.getTime() - mostRecentPriorMs) / 86400000))
    : 999;
 
  return {
    priorBooked,
    priorRevenue: Math.round(priorRevenue),
    isRepeat: priorBooked > 0 ? 1 : 0,
    daysSinceLastRfp,
  };
}
 
/**
 * SMERF-segment RFP count in the last 30 days, from the live pipeline —
 * a direct replacement for the same signal marketSignals.js used to compute
 * from Firestore before that module was removed.
 */
function smerfDemand30d(allRfps) {
  if (!Array.isArray(allRfps)) return 0;
  const SMERF_SEGMENTS = ['smerf', 'social', 'military', 'education', 'religious', 'fraternal', 'government', 'association'];
  const cutoff = Date.now() - 30 * 86400000;
  return allRfps.filter(r => {
    const created = new Date(r.created_at?.toDate?.() || r.inquiry_date || r.Inquiry_Date || 0).getTime();
    if (!(created >= cutoff)) return false;
    const seg = (r.market_segment || r.Market_Segment || '').toLowerCase();
    return SMERF_SEGMENTS.some(s => seg.includes(s));
  }).length;
}
 
/**
 * Builds the real model's feature vector for one RFP.
 *
 * @param rfp        the RFP record (rfps/incoming_rfps shape)
 * @param opts.bookedMap   date -> { rooms, ballroom } map built from booked_events (as in scoreRFP)
 * @param opts.allRfps     merged rfps+incoming_rfps list, for account-history lookups (optional)
 * @param opts.totalRooms  hotel room count (default 220)
 * @param opts.baselineAdr rack-rate baseline (default 164)
 */
export function buildModelFeatures(rfp, opts = {}) {
  const {
    bookedMap = {},
    allRfps = [],
    totalRooms = 220,
    baselineAdr = 164,
  } = opts;
 
  const arrival   = new Date(rfp.arrival_date   || rfp.Arrival_Date);
  const departure = new Date(rfp.departure_date || rfp.Departure_Date);
  const inquiry   = new Date(rfp.inquiry_date   || rfp.Inquiry_Date || Date.now());
  const nights    = Math.max(1, Math.round((departure - arrival) / 86400000));
  const leadTime  = Math.max(0, Math.round((arrival - inquiry) / 86400000));
  const month     = arrival.getMonth() + 1;
  const dow       = arrival.getDay(); // 0=Sun..6=Sat
  const roomBlock = Number(rfp.room_block || rfp.Peak_Room_Block || 0);
  const responseDueDays = Number(rfp.response_due_days || rfp.Response_Due_Days || 10);
 
  // Peak-season distance (spring ~day 75, fall ~day 258 — same anchors used
  // elsewhere in this app for days_to_peak_season).
  const dayOfYear = Math.floor((arrival - new Date(arrival.getFullYear(), 0, 0)) / 86400000);
  const dtsPeak   = Math.min(Math.abs(dayOfYear - 75), Math.abs(dayOfYear - 258));
 
  // ── Room-block-window occupancy (for Rooms_Available_Peak_Date,
  // Is_Compression_Date, avg_discount_nearby_30d) ──
  let maxTaken = 0;
  const nearbyDiscounts = [];
  for (let d = new Date(arrival); d < departure; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const bk = bookedMap[key] || { rooms: 0 };
    maxTaken = Math.max(maxTaken, bk.rooms);
  }
  // avg_discount_nearby_30d: average rack-rate discount on bookings whose
  // stay overlaps the 30 days around this RFP's arrival date. Recomputed
  // here directly from bookedMap (previously done from a wider Firestore
  // query in marketSignals.js, now discarded).
  Object.keys(bookedMap).forEach(key => {
    const d = new Date(key + 'T00:00:00');
    const diffDays = Math.abs((d - arrival) / 86400000);
    if (diffDays <= 30 && bookedMap[key].adr) {
      nearbyDiscounts.push(Math.max(0, baselineAdr - bookedMap[key].adr));
    }
  });
  const avgDiscountNearby30d = nearbyDiscounts.length
    ? nearbyDiscounts.reduce((s, v) => s + v, 0) / nearbyDiscounts.length
    : 12; // neutral fallback when there's no nearby ADR data to average
 
  const roomsAvailPeak = Math.max(0, totalRooms - maxTaken);
  const isCompressionDate = (maxTaken / totalRooms) >= 0.85 ? 1 : 0;
  const isPeakArrival = dtsPeak <= 14 ? 1 : 0;
 
  // ── Competing RFPs in the same arrival week (revenue_competition_7d) ──
  const weekStart = new Date(arrival); weekStart.setDate(weekStart.getDate() - 3);
  const weekEnd   = new Date(arrival); weekEnd.setDate(weekEnd.getDate() + 3);
  const revenueCompetition7d = allRfps.filter(r => {
    if (r.id === rfp.id) return false;
    const a = new Date(r.arrival_date || r.Arrival_Date);
    return !isNaN(a) && a >= weekStart && a <= weekEnd;
  }).length;
 
  const hist = accountHistory(rfp, allRfps);
 
  const eventFormatEnc = EVENT_FORMAT_ENC[rfp.event_format] ?? 1;
  const eventTypeEnc   = EVENT_TYPE_ENC[rfp.event_type] ?? 0;
  const leadSourceEnc  = LEAD_SOURCE_ENC[rfp.lead_source] ?? 0;
 
  const budgetAmount = rfp.budget_provided ? Number(rfp.budget_amount || 0) : 0;
  // Approximation. Real formula (pipeline, Stage 3): budget_amount /
  // proposed_total_revenue — the actual quoted total for the stay. That
  // value doesn't exist yet at prediction time (it's the thing the ADR model
  // is about to produce), so it's unavoidably approximated here using
  // baseline rack rate × room_block × nights as a stand-in for the eventual
  // proposed revenue. This will differ from the training-time value whenever
  // the eventual quote diverges from rack rate.
  const budgetRatio = budgetAmount > 0
    ? budgetAmount / Math.max(1, baselineAdr * roomBlock * nights)
    : 0;
 
  const transientFeats = buildTransientFeatures({
    arrivalDate: arrival,
    departureDate: departure,
    inquiryDate: inquiry,
    roomBlock,
  });
 
  const feats = {
    // ── Directly available from the RFP record ──
    room_block:              roomBlock,
    num_meeting_rooms:       Number(rfp.num_meeting_rooms || 0),
    has_evening_session:     rfp.has_evening_session ? 1 : 0,
    has_reception:           rfp.has_reception ? 1 : 0,
    has_dinner:              rfp.has_dinner ? 1 : 0,
    has_fnb_requirements:    rfp.has_fnb_requirements ? 1 : 0,
    has_premium_av:          rfp.has_premium_av ? 1 : 0,
    uses_ballroom:           (rfp.uses_ballroom || rfp.Uses_Ballroom) ? 1 : 0,
    num_fnb_types:           Number(rfp.num_fnb_types || 0),
    num_sessions:            Number(rfp.num_sessions || 0),
    full_day_pct:            Number(rfp.full_day_pct || 0),
    response_due_days:       responseDueDays,
    Flag_Short_Response_Window: responseDueDays <= 7 ? 1 : 0,
    is_meeting_only:         roomBlock === 0 ? 1 : 0,
    group_size_tier_clean_enc: groupSizeTierEnc(roomBlock),
    event_format_enc:        eventFormatEnc,
    event_type_enc:          eventTypeEnc,
    lead_source_enc:         leadSourceEnc,
    budget_amount:           budgetAmount,
    budget_ratio:            budgetRatio,
    Urgency_Index:           Math.max(0.01, Math.min(0.20, (365 - leadTime) / 3650)),
 
    // ── Derived from arrival/inquiry dates ──
    days_to_peak_season:     Math.min(132, dtsPeak),
    // Verified exact formula from rfp_xgboost_pipeline_v7_1.py:
    // `ev["_month"].isin([3, 4, 9, 10, 11])` — May (5) is NOT shoulder season.
    is_shoulder_season:      [3, 4, 9, 10, 11].includes(month) ? 1 : 0,
    arrival_month_sin:       sinAngle(month, 12),
    arrival_dow_sin:         sinAngle(dow, 7),
    arrival_dow_cos:         cosAngle(dow, 7),
    arrival_day_of_week:     dow,
    inquiry_month_sin:       sinAngle(inquiry.getMonth() + 1, 12),
    lead_time_deviation:     Math.round((leadTime - 45) / 45 * 100) / 100, // vs. an assumed ~45d typical lead time — approximation, see note below
    Is_Compression_Date:     isCompressionDate,
    is_peak_arrival:         isPeakArrival,
 
    // ── Derived from the live booked_events / rfps pipeline ──
    Rooms_Available_Peak_Date: roomsAvailPeak,
    avg_discount_nearby_30d:   Math.round(avgDiscountNearby30d * 100) / 100,
    revenue_competition_7d:    revenueCompetition7d,
    Account_Prior_Booked:      hist.priorBooked,
    Account_Prior_Revenue:     hist.priorRevenue,
    is_repeat_client:          hist.isRepeat,
    days_since_last_rfp:       hist.daysSinceLastRfp,
    smerf_demand_30d:          smerfDemand30d(allRfps),
 
    // ── Approximations of engineered/composite training features ──
    // (formulas are not documented in the report; these are reasonable
    // stand-ins, not reconstructions of the original pipeline)
    Meeting_Space_Ratio: rfp.has_meeting_space ? Math.min(2.0, (Number(rfp.num_meeting_rooms || 1)) / Math.max(1, roomBlock) * 10) : 0,
    meeting_ratio:       rfp.has_meeting_space ? Math.min(2.0, Number(rfp.attendees || 0) / Math.max(1, roomBlock)) : 0,
    avg_room_utilization: (() => { let o = Number(rfp.forecasted_occupancy || 0.72); return o > 1 ? o / 100 : o; })(),
    rate_spread:          baselineAdr * 0.10,
 
    // ── Transient-calendar-derived features (transientDemand.js) ──
    // Exact for tr_transient_occ_of_available / tr_transient_rooms_turned_away
    // / tr_displacement_pressure (reproduces the pipeline's own join_transient()
    // stay-window average/mode). Approximated for the rolling-window
    // composites (documented formula shape, undocumented exact source series
    // — see transientDemand.js header). For inquiry dates outside the real
    // calendar's 2023-2025 coverage (i.e. any live RFP submitted today), these
    // fall back to a same-calendar-day seasonal proxy from the most recent
    // covered year — flagged via transientFeats.sourceIsProxy.
    Flag_Rate_Below_Baseline:        0, // unknown until a rate is quoted
    transient_displacement_cost:     transientFeats.transient_displacement_cost,
    tr_transient_occ_of_available:   transientFeats.tr_transient_occ_of_available,
    tr_transient_rooms_turned_away:  transientFeats.tr_transient_rooms_turned_away,
    tr_displacement_pressure:        transientFeats.tr_displacement_pressure,
    displacement_ema_7d:             transientFeats.displacement_ema_7d,
    occupancy_acceleration:          transientFeats.occupancy_acceleration,
    occupancy_velocity_7_30d:        transientFeats.occupancy_velocity_7_30d,
    revenue_volatility_60d:          transientFeats.revenue_volatility_60d,
    night_variance_pct:              transientFeats.night_variance_pct,
 
    // ── Genuinely unknown — no formula anywhere in the provided pipeline
    // script, model report, or research PDF. Left at 0 rather than invented. ──
    capacity_risk_score:              0,
    revenue_intensity:                0,
    tactical_compression_opportunity: 0,
 
    heckman_imr: 0, // only used by pickup_heckman, which isn't the deployed pickup model (pickup_ipw is — see report Section 7.4)
  };
 
  // Surfaced for callers that want to disclose "seasonal estimate, not live
  // data" in the UI for present-day/future RFPs (inquiry dates in 2026+).
  feats.__transientIsProxy = transientFeats.sourceIsProxy;
 
  MARKET_SEGMENTS.forEach(seg => {
    feats[`market_seg_${seg}`] = (rfp.market_segment || rfp.Market_Segment) === seg ? 1 : 0;
  });
 
  return feats;
}
