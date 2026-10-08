



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

MARKET_SEGMENTS.forEach(seg => {
    feats[`market_seg_${seg}`] = (rfp.market_segment || rfp.Market_Segment) === seg ? 1 : 0;
});

return feats;
}
