


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
 *
 * v3 update: with compute_apit_signals.py, compute_apit.py,
 * enrich_apit_v2_final.py, complete_rfp_features_v2.py and
 * rfp_xgboost_pipeline_v7.py all now available (the actual scripts that
 * produced the training data and the real model, not just the report's
 * prose description of them), every one of the model's 70 real feature names
 * has now been checked against source: several APIT-signal formulas were
 * corrected (Meeting_Space_Ratio, Urgency_Index, Flag_Short_Response_Window,
 * Is_Compression_Date, is_repeat_client, account-history status matching);
 * capacity_risk_score and tactical_compression_opportunity, previously
 * "no formula found", are now computed exactly; night_variance_pct was found
 * to be a raw Cvent metadata field (not a transient-calendar derivation as
 * previously guessed) and is now honestly left at 0 instead of an inferred
 * calendar computation. Two features remain intentionally at 0 because they
 * are provably unreproducible before an RFP is priced — revenue_intensity
 * and Flag_Rate_Below_Baseline — and both were discovered to be
 * leakage-shaped features present, un-excluded, in the real trained model's
 * feature lists (a training-pipeline problem, documented at each site below,
 * not something this file can or should paper over).
 */
 
import { buildTransientFeatures, computeDisplacement } from './transientDemand';
import { buildV8Extras } from './modelFeaturesV8';
 
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
 * Cross-RFP account-history lookup from an already-fetched list of RFPs
 * (rfps + incoming_rfps merged).
 *
 * Verified against the real enrichment scripts (compute_apit.py,
 * enrich_apit_v2_final.py) that produced Account_Prior_Booked /
 * Account_Prior_Revenue in the training data:
 *   - matches are keyed on account_name (exact), matching get_crm()'s own
 *     matching key — this app falls back to organization/contact_email when
 *     account_name isn't present on a live Firestore RFP doc, since those
 *     scripts' account_name field isn't guaranteed to exist on live records.
 *   - the status check is the exact string "Booked" (capital B) — the
 *     previous version of this file checked for 'approved'/'won', which
 *     don't appear anywhere in the real status column (confirmed: the real
 *     values are exactly "Booked"/"Lost") and would have made priorBooked
 *     silently return 0 for every RFP.
 *   - revenue is summed directly from the other RFP's own realized/quoted
 *     revenue field when present (matching get_crm()'s use of
 *     actual_total_revenue for booked prior events), falling back to a
 *     rooms × rate estimate only when no revenue field exists on the record
 *     (live incoming_rfps typically won't have one yet).
 */
function accountHistory(rfp, allRfps) {
  if (!Array.isArray(allRfps) || allRfps.length === 0) {
    return { priorBooked: 0, priorRevenue: 0, isRepeat: 0, daysSinceLastRfp: 999 };
  }
  const acctName = (rfp.account_name || rfp.Account_Name || '').trim().toLowerCase();
  const org = (rfp.organization || rfp.Organization || '').trim().toLowerCase();
  const email = (rfp.contact_email || rfp.Contact_Email || '').trim().toLowerCase();
  if (!acctName && !org && !email) return { priorBooked: 0, priorRevenue: 0, isRepeat: 0, daysSinceLastRfp: 999 };
 
  const inquiryDate = new Date(rfp.inquiry_date || rfp.Inquiry_Date || Date.now());
  let priorBooked = 0;
  let priorRevenue = 0;
  let mostRecentPriorMs = null;
 
  allRfps.forEach(other => {
    if (other.id === rfp.id) return;
    const otherAcct = (other.account_name || other.Account_Name || '').trim().toLowerCase();
    const otherOrg = (other.organization || other.Organization || '').trim().toLowerCase();
    const otherEmail = (other.contact_email || other.Contact_Email || '').trim().toLowerCase();
    const sameAccount = (acctName && otherAcct === acctName)
      || (org && otherOrg === org) || (email && otherEmail === email);
    if (!sameAccount) return;
 
    const otherInquiry = new Date(other.inquiry_date || other.Inquiry_Date || 0);
    if (!isNaN(otherInquiry) && otherInquiry < inquiryDate) {
      if (mostRecentPriorMs === null || otherInquiry.getTime() > mostRecentPriorMs) {
        mostRecentPriorMs = otherInquiry.getTime();
      }
    }
 
    const status = (other.status || other.Status || '').trim().toLowerCase();
    if (status === 'booked') {
      priorBooked += 1;
      const realizedRevenue = Number(
        other.actual_total_revenue || other.Actual_Total_Revenue
        || other.proposed_total_revenue || other.Proposed_Total_Revenue || 0
      );
      if (realizedRevenue > 0) {
        priorRevenue += realizedRevenue;
      } else {
        const rooms = Number(other.room_block || other.Peak_Room_Block || 0);
        const rate  = Number(other.quoted_adr  || other.Quoted_ADR     || 0) || 164 * 0.88;
        priorRevenue += rooms * rate;
      }
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
  // UTC getters: new Date('YYYY-MM-DD') is UTC midnight, so local getMonth()/getDay() are off by one
  // day in US time zones (Eastern: a Monday arrival read as Sunday; the 1st of a month read as the prior month).
  const month     = arrival.getUTCMonth() + 1;
  const dow       = arrival.getUTCDay(); // 0=Sun..6=Sat
  const roomBlock = Number(rfp.room_block || rfp.Peak_Room_Block || 0);
  const responseDueDays = Number(rfp.response_due_days || rfp.Response_Due_Days || 10);
  // Normalized to a 0-100 scale, matching Forecasted_Occupancy in the source data.
  const forecastedOccPct = (() => {
    const o = Number(rfp.forecasted_occupancy ?? rfp.Forecasted_Occupancy ?? 72);
    return o <= 1 ? o * 100 : o;
  })();
 
  // Peak-season distance (spring ~day 75, fall ~day 258 — same anchors used
  // elsewhere in this app for days_to_peak_season).
  const dayOfYear = Math.floor((arrival - Date.UTC(arrival.getUTCFullYear(), 0, 0)) / 86400000);
  const dtsPeak   = Math.min(Math.abs(dayOfYear - 75), Math.abs(dayOfYear - 258));
 
  // ── Room-block-window occupancy (for Rooms_Available_Peak_Date,
  // Is_Compression_Date, avg_discount_nearby_30d, capacity_risk_score) ──
  let maxTaken = 0;
  let onBooksRoomNights = 0; // sum of rooms already on books across each stay night
  const nearbyDiscounts = [];
  for (let d = new Date(arrival); d < departure; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const bk = bookedMap[key] || { rooms: 0 };
    maxTaken = Math.max(maxTaken, bk.rooms);
    onBooksRoomNights += bk.rooms;
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
  // Verified exact formula from compute_apit_signals.py / enrich_apit_v2_final.py:
  // Is_Compression_Date = Forecasted_Occupancy >= 85 — a simple threshold on the
  // RFP's own forecast field, not derived from the booked-room window (the
  // previous version of this file used maxTaken/totalRooms >= 0.85, which is a
  // different, invented definition).
  const isCompressionDate = forecastedOccPct >= 85 ? 1 : 0;
  const isPeakArrival = dtsPeak <= 14 ? 1 : 0;
 
  // ── capacity_risk_score / tactical_compression_opportunity ──
  // Verified exact formulas from complete_rfp_features_v2.py (Parts 3, 5, 8) —
  // this is the earlier feature-engineering script that produced the base
  // rfp_training_data columns before the APIT enrichment scripts ran. Both
  // features were previously left at 0 as "no formula found"; that was true
  // until this script surfaced. Both are legitimately computable pre-quote
  // (unlike revenue_intensity/meeting_ratio below — see their comment).
  //
  // compression_indicator: a graduated version of Is_Compression_Date.
  const compressionIndicator =
    forecastedOccPct >= 85 ? 1.0 :
    forecastedOccPct >= 75 ? 0.7 :
    forecastedOccPct >= 65 ? 0.4 : 0.0;
  const tacticalCompressionOpportunity = compressionIndicator * (1 / (leadTime + 1));
 
  // operational_complexity_score (Part 5): 1.0 base + up to 4 for room-block
  // size + 2 for a "Full Package" (meeting space + F&B) request + 1 for
  // needing meeting space at all + 2 for attendees > 100.
  const needsMeetingSpace = Number(rfp.num_meeting_rooms || 0) > 0 || !!rfp.has_meeting_space;
  const isFullPackage = !!rfp.has_meeting_space && !!rfp.has_fnb_requirements;
  const operationalComplexityScore =
    1.0
    + Math.min(4, roomBlock / 50)
    + (isFullPackage ? 2 : 0)
    + (needsMeetingSpace ? 1 : 0)
    + (Number(rfp.attendees || 0) > 100 ? 2 : 0);
 
  // group_size_intensity / capacity_utilization_pct (Part 5). NOTE: the
  // source script hardcodes TOTAL_ROOMS=280, which conflicts with every other
  // script and this app's own default (220 — see compute_apit.py's
  // hotel_capacity default and rfp_xgboost_pipeline_v7.py's own
  // TOTAL_ROOMS=220). That's an inconsistency in the original scripts
  // themselves, not something resolvable from here; this app uses its
  // existing 220-room convention for consistency with every other feature.
  const groupSizeIntensity = roomBlock > 0 ? (roomBlock / totalRooms * 100) : 0;
  const stayCapacity = totalRooms * nights;
  const onBooksOccupancyPct = stayCapacity > 0 ? (onBooksRoomNights / stayCapacity) * 100 : 0;
  const additionalOccupancyPct = stayCapacity > 0 ? (roomBlock * nights / stayCapacity) * 100 : 0;
  const capacityUtilizationPct = Math.min(100, onBooksOccupancyPct + additionalOccupancyPct);
  const capacityRiskScore =
    (capacityUtilizationPct / 100) * (groupSizeIntensity / 100) * (1 + operationalComplexityScore / 10);
 
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
    // Verified exact threshold from compute_apit_signals.py: <= 5 days, not 7.
    Flag_Short_Response_Window: responseDueDays <= 5 ? 1 : 0,
    is_meeting_only:         roomBlock === 0 ? 1 : 0,
    group_size_tier_clean_enc: groupSizeTierEnc(roomBlock),
    event_format_enc:        eventFormatEnc,
    event_type_enc:          eventTypeEnc,
    lead_source_enc:         leadSourceEnc,
    budget_amount:           budgetAmount,
    budget_ratio:            budgetRatio,
    // Verified exact formula from compute_apit.py / compute_apit_signals.py:
    // Urgency_Index = response_due_days / lead_time (0 when lead_time is 0).
    // The previous version of this file used a fabricated formula
    // ((365-leadTime)/3650, clamped 0.01-0.20) that doesn't match the real
    // definition at all.
    Urgency_Index:           leadTime > 0 ? responseDueDays / leadTime : 0,
 
    // ── Derived from arrival/inquiry dates ──
    days_to_peak_season:     Math.min(132, dtsPeak),
    // Verified exact formula from rfp_xgboost_pipeline_v7_1.py:
    // `ev["_month"].isin([3, 4, 9, 10, 11])` — May (5) is NOT shoulder season.
    is_shoulder_season:      [3, 4, 9, 10, 11].includes(month) ? 1 : 0,
    arrival_month_sin:       sinAngle(month, 12),
    arrival_dow_sin:         sinAngle(dow, 7),
    arrival_dow_cos:         cosAngle(dow, 7),
    arrival_day_of_week:     dow,
    inquiry_month_sin:       sinAngle(inquiry.getUTCMonth() + 1, 12),
    lead_time_deviation:     Math.round((leadTime - 45) / 45 * 100) / 100, // vs. an assumed ~45d typical lead time — approximation, see note below
    Is_Compression_Date:     isCompressionDate,
    is_peak_arrival:         isPeakArrival,
 
    // ── Derived from the live booked_events / rfps pipeline ──
    Rooms_Available_Peak_Date: roomsAvailPeak,
    avg_discount_nearby_30d:   Math.round(avgDiscountNearby30d * 100) / 100,
    revenue_competition_7d:    revenueCompetition7d,
    Account_Prior_Booked:      hist.priorBooked,
    Account_Prior_Revenue:     hist.priorRevenue,
    // Verified exact formula from compute_apit_signals.py, Group C:
    // Is_Repeat_Client = (lead_source == "Repeat Client") — a simple flag on
    // the RFP's own intake field, not derived from cross-RFP account history.
    // The previous version of this file used hist.isRepeat (priorBooked > 0),
    // which is a reasonable live signal but not what the model was trained
    // on — switched to the exact source definition.
    is_repeat_client:          rfp.lead_source === 'Repeat Client' ? 1 : 0,
    days_since_last_rfp:       hist.daysSinceLastRfp,
    smerf_demand_30d:          smerfDemand30d(allRfps),
 
    // Verified exact formula from compute_apit_signals.py, Group A:
    // Meeting_Space_Ratio = (num_meeting_rooms / attendees) * 10 — divides by
    // ATTENDEES, not room_block. The previous version of this file divided
    // by roomBlock, which is a different (wrong) ratio.
    Meeting_Space_Ratio: Number(rfp.attendees) > 0
      ? Number(rfp.num_meeting_rooms || 0) / Number(rfp.attendees) * 10
      : 0,
    // meeting_ratio (lowercase) is a distinct feature from Meeting_Space_Ratio.
    // Found now in complete_rfp_features_v2.py (Part 7): meeting_ratio =
    // Proposed_Meeting_Revenue / Proposed_Total_Revenue — i.e. the meeting
    // revenue SHARE of the proposal the hotel already sent the client. Like
    // budget_ratio, this can't be reproduced honestly before a quote exists
    // (proposed revenue is the output of pricing this RFP, not an input to
    // it), so the prior approximation stands.
    meeting_ratio:       rfp.has_meeting_space ? Math.min(2.0, Number(rfp.attendees || 0) / Math.max(1, roomBlock)) : 0,
    // avg_room_utilization / rate_spread: confirmed in complete_rfp_features_v2.py
    // (Part 16) to be raw external fields merged in from a Cvent RFP-metadata
    // export (Avg_Room_Utilization, Rate_Spread columns in Enhanced_All_Events_v3.csv)
    // — not computed by any formula in the pipeline at all. There's nothing to
    // "correct" here; this app's RFP intake doesn't collect that Cvent metadata,
    // so the existing approximations (occupancy proxy / 10% of baseline ADR)
    // are the honest best-effort stand-ins.
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
    // Exact training-time formula (compute_apit_signals.py, Group C):
    // Flag_Rate_Below_Baseline = quoted_adr < baseline_adr * 0.97. This is
    // computed FROM quoted_adr — the ADR model's own target — and it is NOT
    // excluded from the quoted_adr/conversion feature pool anywhere in
    // rfp_xgboost_pipeline_v7_1.py (checked ALWAYS_EXCLUDE and LEAKY; it's
    // absent from both), yet it IS present in the real exported model's
    // feature list (index 1 of quoted_adr's 36 features). That means the
    // ADR model was trained with a feature that's a deterministic function
    // of its own target — target leakage in the training pipeline, not a
    // deployment bug. It should inflate the reported training/test metrics
    // and cannot be honestly reproduced at real inference time anyway, since
    // quoted_adr doesn't exist yet for a not-yet-priced RFP. Left at 0 here,
    // which was already correct — this comment just documents why.
    Flag_Rate_Below_Baseline:        0,
    transient_displacement_cost:     transientFeats.transient_displacement_cost,
    tr_transient_occ_of_available:   transientFeats.tr_transient_occ_of_available,
    tr_transient_rooms_turned_away:  transientFeats.tr_transient_rooms_turned_away,
    tr_displacement_pressure:        transientFeats.tr_displacement_pressure,
    displacement_ema_7d:             transientFeats.displacement_ema_7d,
    occupancy_acceleration:          transientFeats.occupancy_acceleration,
    occupancy_velocity_7_30d:        transientFeats.occupancy_velocity_7_30d,
    revenue_volatility_60d:          transientFeats.revenue_volatility_60d,
    // CORRECTED: previously computed as a coefficient-of-variation of
    // transient occupancy across the stay window — an inferred-from-the-name
    // guess, explicitly flagged as unverified in transientDemand.js's header.
    // complete_rfp_features_v2.py (Part 16) now shows the real source:
    // Night_Variance_Pct is a raw Cvent RFP-metadata field merged in from
    // Enhanced_All_Events_v3.csv (same family as rate_spread, avg_room_utilization,
    // has_suites) — NOT derived from the transient occupancy calendar at all.
    // This app's RFP intake doesn't collect that Cvent field, so the honest
    // value is 0/unknown, not the calendar-based guess. (The transientDemand.js
    // helper that used to compute this is left in place but unused here.)
    night_variance_pct:              0,
 
    // capacity_risk_score / tactical_compression_opportunity: previously "no
    // formula found, left at 0" — now computed exactly per
    // complete_rfp_features_v2.py (see the block above where they're derived).
    capacity_risk_score:              capacityRiskScore,
    tactical_compression_opportunity: tacticalCompressionOpportunity,
    // revenue_intensity: found in complete_rfp_features_v2.py (Part 7) —
    // Proposed_Total_Revenue / Total_Room_Nights_Requested. This is a SECOND
    // leakage-shaped feature, worse than Flag_Rate_Below_Baseline: it's used
    // un-excluded in ALL FOUR non-pickup-uncorrected models (quoted_adr,
    // conversion, pickup_ipw, fnb — confirmed directly against
    // xgboost_trees_data_v7.js's feature lists), and it's built from
    // Proposed_Total_Revenue, which is the hotel's own quote — for a
    // room-block-dominated stay that's arithmetically close to
    // quoted_adr × room_nights, i.e. a near-restatement of the ADR model's
    // own target folded into every other model too. Like
    // Flag_Rate_Below_Baseline, it doesn't exist yet for an unpriced RFP, so
    // it's correctly left at 0 here — this is a training-pipeline problem to
    // fix (exclude it, retrain), not something to reproduce.
    revenue_intensity:                0,
 
    heckman_imr: 0, // only used by pickup_heckman, which isn't the deployed pickup model (pickup_ipw is — see report Section 7.4)
  };
 
  // Surfaced for callers that want to disclose "seasonal estimate, not live
  // data" in the UI for present-day/future RFPs (inquiry dates in 2026+).
  feats.__transientIsProxy = transientFeats.sourceIsProxy;
 
  // ── Inputs for the newest models (xgboost_trees_data_v8.js) ──
  // See modelFeaturesV8.js for where each value comes from and how it is labeled.
  const _disp = computeDisplacement({ arrivalDate: arrival, departureDate: departure, roomBlock, bookedMap, totalRooms });
  const _attendees = Number(rfp.attendees || 0);
  const _hasMtg = !!(rfp.has_meeting_space ?? true);
  const _roomRev = baselineAdr * roomBlock * nights;
  const _fnbRev = rfp.has_fnb_requirements ? _attendees * 65 : 0;          // Placeholder $/person until the F&B model runs
  const _mtgRev = _hasMtg ? roomBlock * nights * 18 : 0;                    // CONFIG_DEFAULTS meeting_rate_per_room_night
  const _proposed = opts.proposedTotalRevenue; // undefined -> estimated by the helper models in modelFeaturesV8.js
  const v8 = buildV8Extras(rfp, {
    nights, month, dow: (dow + 6) % 7, dayOfYear, leadTime, roomBlock,
    perNight: _disp.perNight, totalRooms, baselineAdr, leadTime,
    proposedTotalRevenue: _proposed, roomRevenue: _roomRev, meetingRevenue: _mtgRev,
  });
  Object.assign(feats, v8);
  // night_variance_pct is a raw Cvent field the form doesn't collect; training median is 0 (56% zeros).
  feats.night_variance_pct = Number(rfp.night_variance_pct ?? 0);
  feats.__v8 = true;

  MARKET_SEGMENTS.forEach(seg => {
    feats[`market_seg_${seg}`] = (rfp.market_segment || rfp.Market_Segment) === seg ? 1 : 0;
  });
 
  return feats;
}
