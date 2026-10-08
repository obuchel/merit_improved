// modelFeaturesV8.js
// Extra input features needed by the newest models (xgboost_trees_data_v8.js:
// quoted_adr, conversion, pickup_ipw, fnb). buildModelFeatures() calls
// buildV8Extras() and merges the result into its feature dict, so every model
// can be called with the same dict.
//
// Where each value comes from (label in brackets):
//   [Observed]   read straight from the RFP form
//   [Rule]       deterministic formula, same as the training pipelines
//   [Estimated]  seasonal / segment lookup built from the training table
//                (rfp_training_data_complete_v3_with_transient.csv), used when
//                the live app has no history to compute the rolling feature
//
// NOTE on leakage: the first ADR model took rate_discount_pct, pricing_pressure_index
// and transient_displacement_cost as inputs. Those are computed from quoted_adr, the
// model's own target, so its R2 0.978 was inflated. The ADR model used here was
// retrained without price-derived inputs (15 calendar/market features, test R2 0.908,
// MAE $6.32), so no placeholder for those columns is needed any more.

import { predictModel } from './modelRunTime';
import { XGBOOST_TREES_V8 } from './xgboost_trees_data_v8';

export const V8_WEEK_DEMAND = {"1":31,"2":27,"3":20,"4":26,"5":39,"6":29,"7":29,"8":35,"9":28,"10":30,"11":44,"12":26,"13":47,"14":43,"15":38,"16":35,"17":30,"18":41,"19":35,"20":39,"21":44,"22":36,"23":42,"24":42,"25":44,"26":42,"27":43,"28":37,"29":45,"30":32,"31":57,"32":40,"33":32,"34":43,"35":39,"36":39,"37":40,"38":38,"39":41,"40":43,"41":37,"42":45,"43":45,"44":39,"45":25,"46":46,"47":35,"48":31,"49":21,"50":29,"51":29,"52":26};
export const V8_FORECAST_OCC_BY_MONTH = {1:88.2,2:89.7,3:100,4:100,5:100,6:100,7:100,8:100,9:100,10:100,11:100,12:73.8};
export const V8_TABLES = {"segment_avg_revenue_intensity":{"Association":1293.7058,"Corporate":1031.2938,"SMERF":788.6151,"Wedding/Social":653.1908},"segment_expected_pickup_mean":{"Association":0.7158,"Corporate":0.8816,"SMERF":0.8483,"Wedding/Social":0.5853},"historical_demand_this_month":{"1":121,"2":129,"3":153,"4":155,"5":180,"6":178,"7":183,"8":183,"9":169,"10":185,"11":149,"12":114},"room_night_demand_7d":{"1":334.0,"2":431.0,"3":497.0,"4":468.0,"5":482.5,"6":457.0,"7":573.0,"8":485.0,"9":497.0,"10":490.0,"11":431.0,"12":321.5},"room_night_demand_90d":{"1":4454.0,"2":6704.0,"3":7094.0,"4":6968.0,"5":7607.0,"6":7398.0,"7":8331.0,"8":6915.0,"9":7870.0,"10":7244.0,"11":5918.0,"12":5244.5},"revenue_competition_14d":{"1":8314.99,"2":6745.29,"3":8585.96,"4":7845.12,"5":11054.48,"6":13456.05,"7":11493.65,"8":12297.9,"9":5170.3,"10":11877.88,"11":9450.14,"12":3936.45},"avg_discount_nearby_60d":{"1":27.92,"2":27.79,"3":21.39,"4":13.54,"5":11.93,"6":17.01,"7":21.59,"8":18.82,"9":13.41,"10":11.9,"11":16.6,"12":24.63},"days_since_last_segment_rfp_median":2.0,"pricing_pressure_index_median":1.094,"rate_discount_pct_median":10.7,"org_industry_codes":{"Education":0,"Finance":1,"Government":2,"Healthcare":3,"Legal":4,"Other":5,"Professional Services":6,"Religious":7,"Social/Community":8,"Social/Private":9,"Technology":10,"Trade/Manufacturing":11,"Travel/Hospitality":12},"proposal_share":{"room_revenue_ratio_median":0.682,"meeting_ratio_median":0.078}};

const LEAD_SOURCE_CODE = { 'Sales Call':0, 'Cvent':1, 'Third-Party Planner':2, 'Website':3,
  'Direct Inquiry':4, 'Repeat Client':5, 'RFP':6, 'Referral':7 };

// pd.Categorical(...).codes = alphabetical: short_stay 0, single_night 1, weekend 2
function lengthOfStayCode(nights) {
  if (nights <= 1) return 1;
  if (nights === 2) return 2;
  return 0;
}

const TIER_CODE = d => d <= 70 ? 0 : d <= 114 ? 1 : d <= 158 ? 2 : d <= 193 ? 3 : 4; // Soft..Peak

const COMPLETENESS_FIELDS = 15; // Attendees, block, nights, lead time, response due, budget flag/amount,
                                // destinations, segment, priority, meeting, F&B, occupancy, baseline, quoted

// ISO week (1-52/53) of a YYYY-MM-DD date, computed in UTC like the training table.
function isoWeekUTC(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil((((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7);
}

/**
 * @param rfp   RFP record
 * @param c     { nights, month, dow(Mon=0), dayOfYear, leadTime, roomBlock, perNight,
 *                proposedTotalRevenue, roomRevenue, meetingRevenue, totalRooms }
 *              perNight: computeDisplacement().perNight  (transientDemand, transientADR, committed)
 */
export function buildV8Extras(rfp, c) {
  const seg = rfp.market_segment || rfp.Market_Segment || '';
  const evType = rfp.event_type || rfp.Event_Type || 'Corporate';
  const month = c.month;
  const q = Math.floor((month - 1) / 3) + 1;

  // Stay-window transient summary (tr_* features): mean ADR, mean RevPAR, modal demand tier
  const pn = c.perNight || [];
  const trAdr = pn.length ? pn.reduce((s, n) => s + (n.transientADR || 0), 0) / pn.length : 0;
  const rooms = c.totalRooms || 220;
  const trRevpar = pn.length
    ? pn.reduce((s, n) => s + (n.transientADR || 0) * Math.min(n.transientDemand || 0, Math.max(0, rooms - (n.committed || 0))) / rooms, 0) / pn.length
    : 0;
  let trTier = 2;
  if (pn.length) {
    const counts = {};
    pn.forEach(n => { const t = TIER_CODE(n.transientDemand || 0); counts[t] = (counts[t] || 0) + 1; });
    trTier = Number(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]);
  }

  const nSessions = Number(rfp.num_sessions || 0);
  const nRoomTypes = Number(rfp.num_room_types || 3);
  const segPickup = V8_TABLES.segment_expected_pickup_mean[evType] ?? 0.8;
  const confidentPickup = Math.min(1, Math.max(0.4, segPickup * (1 + 0.02 * Math.min(6, Math.max(0, nRoomTypes)))));

  // Proposal composition (proposed revenue, room share, meeting share). Three conversion inputs are shares of
  // the hotel's own proposal, which does not exist before pricing, so they are predicted from RFP-known fields
  // by three small helper models (est_*, hold-out R2 0.93 / 0.94 / 0.62; see convert.py).
  const hb = {
    room_block: c.roomBlock, nights: c.nights, attendees: Number(rfp.attendees || 0),
    num_meeting_rooms: Number(rfp.num_meeting_rooms || 0), total_meeting_hours: Number(rfp.total_meeting_hours || 0),
    num_sessions: nSessions, full_day_pct: Number(rfp.full_day_pct || 0), num_fnb_types: Number(rfp.num_fnb_types || 0),
    has_meeting_space: (rfp.has_meeting_space ?? true) ? 1 : 0, has_fnb_requirements: rfp.has_fnb_requirements ? 1 : 0,
    has_dinner: rfp.has_dinner ? 1 : 0, has_reception: rfp.has_reception ? 1 : 0,
    max_av_level: Number(rfp.max_av_level ?? 2), baseline_adr: c.baselineAdr || 164,
  };
  const estProp = predictModel(XGBOOST_TREES_V8, 'est_proposed_total_revenue', hb);
  const estRoomShare = predictModel(XGBOOST_TREES_V8, 'est_room_revenue_ratio', hb);
  const estMtgShare = predictModel(XGBOOST_TREES_V8, 'est_meeting_ratio', hb);
  const prop = Math.max(1, c.proposedTotalRevenue ?? estProp ?? 0);
  // Completeness_Score = share of 15 fields present; numeric fields count only when non-zero.
  // Quoted_ADR is counted as present (it exists in training; here it is what the model produces).
  const nz = x => Number(x) > 0;
  const has = x => x !== undefined && x !== null && x !== '';
  const filled = [nz(rfp.attendees), nz(rfp.room_block), nz(c.nights), nz(c.leadTime), nz(rfp.response_due_days),
    has(rfp.budget_provided), nz(rfp.budget_amount), nz(rfp.destinations_considered), has(seg), has(rfp.client_priority),
    has(rfp.has_meeting_space), has(rfp.has_fnb_requirements), has(rfp.forecasted_occupancy), nz(c.baselineAdr), true]
    .filter(Boolean).length;

  // Stay-window transient occupancy of available rooms (%), from the forecast / calendar
  const trOccAvail = pn.length
    ? pn.reduce((s, n) => { const cap = Math.max(0, rooms - (n.committed || 0)); return s + (cap > 0 ? Math.min(n.transientDemand || 0, cap) / cap * 100 : 100); }, 0) / pn.length
    : 0;

  // Price-derived inputs of the ADR model, made mutually consistent with ONE neutral assumption: a typical
  // discount to the baseline rate. In training: transient_displacement_cost = max(0, baseline - quoted) x
  // room-nights; rate_discount_pct = 100 x (baseline - quoted) / baseline; displacement_ratio = that cost /
  // proposed revenue; pricing_pressure_index = rate_discount_pct / (displacement_ratio x 100).

  return {
    // [Rule] calendar. Training used Monday=0 (pandas dayofweek); the app's getDay() is Sunday=0.
    arrival_day_of_week:        c.dow,
    // Season flags as defined in the training table (the older v7 table used different months)
    is_peak_arrival:            [6, 7, 8, 12].includes(month) ? 1 : 0,
    is_shoulder_season:         [3, 4, 5, 9, 10].includes(month) ? 1 : 0,
    // Compression = stay-window transient occupancy of available rooms above 97.85% (best single split in training, 91% agreement)
    Is_Compression_Date:        trOccAvail > 97.85 ? 1 : 0,
    arrival_day_of_year:        c.dayOfYear,
    // Share of the 220 rooms already committed on the stay nights (excluding this group)
    on_books_occupancy_pct:     pn.length ? pn.reduce((s, n) => s + (n.committed || 0), 0) / (pn.length * rooms) * 100 : 0,
    lead_time_days:             c.leadTime,
    // [Observed if the form has it, else Estimated from the training table's month median]
    forecasted_occupancy:       (() => { const o = Number(rfp.forecasted_occupancy ?? rfp.Forecasted_Occupancy); if (Number.isFinite(o) && o > 0) return o <= 1 ? o * 100 : o; return V8_FORECAST_OCC_BY_MONTH[month] ?? 100; })(),
    destinations_considered:    Number(rfp.destinations_considered ?? 2),
    attendees:                  Number(rfp.attendees || 0),
    nights:                     c.nights,
    budget_provided:            (rfp.budget_provided === true || rfp.budget_provided === 1 || rfp.budget_provided === 'true' || Number(rfp.budget_amount) > 0) ? 1 : 0,
    decision_days_cvent:        Number(rfp.decision_days_cvent ?? rfp.decision_days ?? 27),
    arrival_quarter_cos:        Math.cos(2 * Math.PI * q / 4),
    days_to_next_quarter:       30 * (3 - ((month - 1) % 3)),
    // Estimated: weekly demand count from the training table's ISO-week lookup (Simulated history)
    historical_demand_this_week: V8_WEEK_DEMAND[isoWeekUTC(rfp.arrival_date)] ?? 38,
    // [Observed]
    decision_time_days:         Number(rfp.decision_days_cvent ?? rfp.decision_days ?? 27),
    max_av_level:               Number(rfp.max_av_level ?? 2),
    total_meeting_hours:        Number(rfp.total_meeting_hours || 0),
    lead_source_encoded:        LEAD_SOURCE_CODE[rfp.lead_source] ?? 4,
    length_of_stay_category_enc: lengthOfStayCode(c.nights),
    organization_industry_enc:  V8_TABLES.org_industry_codes[rfp.organization_industry] ?? V8_TABLES.org_industry_codes['Other'],
    market_seg_Healthcare:      seg === 'Healthcare' ? 1 : 0,
    market_seg_Travel:          seg === 'Travel' ? 1 : 0,
    market_seg_SMERF:           seg === 'SMERF' ? 1 : 0,
    // [Rule]
    pickup_momentum:            nSessions > 4 ? 0.90 : nSessions > 2 ? 0.85 : 0.80,
    confident_expected_pickup:  confidentPickup,
    // [Estimated] segment / seasonal lookups from the training table
    segment_avg_revenue_intensity: V8_TABLES.segment_avg_revenue_intensity[evType] ?? 1004,
    historical_demand_this_month:  V8_TABLES.historical_demand_this_month[month] ?? 162,
    room_night_demand_7d:          V8_TABLES.room_night_demand_7d[month] ?? 479,
    room_night_demand_90d:         V8_TABLES.room_night_demand_90d[month] ?? 6312,
    revenue_competition_14d:       V8_TABLES.revenue_competition_14d[month] ?? 9000,
    avg_discount_nearby_60d:       V8_TABLES.avg_discount_nearby_60d[month] ?? 18,
    days_since_last_segment_rfp:   V8_TABLES.days_since_last_segment_rfp_median,
    Completeness_Score:            Math.round(filled / COMPLETENESS_FIELDS * 1000) / 10,
    // [Estimated] from the transient calendar / modeled forecast over the stay window
    tr_transient_adr:           trAdr,
    tr_transient_revpar:        trRevpar,
    tr_demand_tier:             trTier,
    // [Estimated] share of the proposal (price-dependent, so estimated from the baseline quote)
    proposed_total_revenue:     prop,
    room_revenue_ratio:         Math.min(1, Math.max(0, estRoomShare ?? V8_TABLES.proposal_share.room_revenue_ratio_median)),
    meeting_ratio:              Math.min(1, Math.max(0, estMtgShare ?? V8_TABLES.proposal_share.meeting_ratio_median)),
    // [Placeholder] derived from the model's own target (see leakage note); neutral, mutually consistent values
  };
}
