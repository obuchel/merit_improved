

/**
 * modelRuntime.js
 *
 * Shared XGBoost tree-sum runtime + base_score calibration.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────
 * Every one of the 6 exported models in xgboost_trees_data_v7.js carries the
 * exact same base_score, "b": 0.5 — including four regression heads
 * (quoted_adr, fnb, pickup_uncorr, pickup_ipw, pickup_heckman) whose real
 * targets are raw dollars (~$134 avg ADR, ~$69 avg F&B/person) or a 0-1 rate
 * (~0.77 avg pickup), not something meaningfully centered at 0.5.
 *
 * This is directly demonstrable: feeding real feature vectors for two very
 * different RFPs (a 20-room Association group and an 80-room Finance
 * conference, different dates, different segments) through the real
 * exported trees produces raw quoted_adr outputs of -2.7 and +1.9 — nowhere
 * near a real $80-$220 ADR. Both fail the app's own (80,400) sanity check
 * and silently fall back to the same fixed formula (baseline_adr × 0.88),
 * which doesn't depend on the RFP at all — hence pricing strategies that
 * looked identical across completely different bookings.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 * The original .pkl (and whatever script exported it to this JS file)
 * aren't available to us, so the model's true fitted base_score can't be
 * recovered exactly. What IS recoverable: modern XGBoost auto-initializes
 * base_score from the mean of the training target when it isn't explicitly
 * set — and nothing in rfp_xgboost_pipeline_v7_1.py ever sets it — so the
 * mean of each model's real target column in
 * rfp_training_data_complete_v3.csv is the standard, principled
 * reconstruction of what base_score should have been. That's what
 * XGB_BASE_SCORE_CORRECTION below is: a calibration, not a guess, but also
 * not a verified recovery of the exact original value — flag it if
 * predictions still look systematically off once real outcomes come in.
 *
 * Also fixed here: pickup_uncorr/pickup_ipw/pickup_heckman were trained
 * (rfp_xgboost_pipeline_v7_1.py, train_pickup_corrected()) as plain
 * XGBRegressor on actual_pickup_rate — never through a binary:logistic /
 * sigmoid objective. The app was passing pickup's raw output through
 * sigmoid() anyway, copying the pattern used for the genuinely-classifier
 * `conversion` model. That's a second, independent bug on top of the
 * base_score issue. Pickup predictions are now clipped directly instead of
 * sigmoid-transformed.
 */
 
// Mean of each regression target — Mine.pdf Section 3.2 ("Outcome
// distribution") publishes these directly, already filtered to each
// target's exact training subset, so these are no longer a rough estimate
// from the raw CSV — they're the report's own numbers:
//   Quoted ADR:  training subset room_block>0 (matches FIX 1), n=1,705, mean=$149.41
//   Pickup rate: training subset booked-only,                 n=1,299, mean=0.77
//   F&B/person:  training subset booked & >0,                 n=1,137, mean=$68.68
export const XGB_BASE_SCORE_CORRECTION = {
  quoted_adr:     149.41, // Mine.pdf Section 3.2, "Quoted ADR" row
  fnb:             68.68, // Mine.pdf Section 3.2, "F&B per person" row
  pickup_uncorr:   0.77,  // Mine.pdf Section 3.2, "Pickup rate" row
  pickup_ipw:      0.77,  // same target column — only the sample weighting differs at training time
  pickup_heckman:  0.77,
};
 
// conversion is a real classifier (binary:logistic) — base_score is
// legitimately probability-space, but the true fitted value should reflect
// the real positive rate (76.6% booked — Mine.pdf Section 3.2, "Conversion"
// row), not the generic 0.5 default. Correct by shifting the pre-sigmoid
// margin by the difference between the real base rate's logit and
// logit(0.5)=0 (the
// margin the exported b=0.5 already implies).
const CONVERSION_BASE_RATE = 0.7662; // mean(did_convert)
const CONVERSION_MARGIN_CORRECTION =
  Math.log(CONVERSION_BASE_RATE / (1 - CONVERSION_BASE_RATE));
 
function evalTree(nodes, features) {
  let node = nodes[0];
  while (Array.isArray(node) && node.length >= 4) {
    // v7 nodes: [feature, threshold, yes, no]  (missing -> no)
    // v8 nodes: [feature, threshold, yes, no, missing]  (missing follows the trained default direction)
    const [fIdx, threshold, yes, no, missing] = node;
    const val = features[fIdx];
    const isMissing = val === null || val === undefined || isNaN(val);
    // XGBoost compares in float32; Math.fround keeps ties on split points identical to Python.
    node = nodes[isMissing ? (missing !== undefined ? missing : no) : (Math.fround(val) < Math.fround(threshold) ? yes : no)];
  }
  return Array.isArray(node) ? node[0] : node;
}
 
function xgbPredictRaw(model, feats) {
  let s = model.b; // the exported (uncalibrated) 0.5 base score
  for (const t of model.t) s += evalTree(t, feats);
  return s;
}
 
const sigmoid = x => 1 / (1 + Math.exp(-x));
 
/**
 * Predicts one of the six trained XGBoost heads from a feature-name dict
 * (as built by buildModelFeatures), applying the base_score calibration
 * correction above and the correct link function per model.
 *
 * @param XGBOOST_TREES  the imported XGBOOST_TREES object
 * @param name    'quoted_adr' | 'conversion' | 'pickup_uncorr' | 'pickup_ipw' | 'pickup_heckman' | 'fnb'
 * @param dict    feature-name -> value, from buildModelFeatures()
 * @returns dollars (quoted_adr, fnb), a 0-1 rate (pickup_*), or a 0-1
 *          probability (conversion) — calibrated, never the raw exported
 *          margin. Returns null if the model name isn't present in
 *          XGBOOST_TREES.
 */
export function predictModel(XGBOOST_TREES, name, dict) {
  const m = XGBOOST_TREES?.[name];
  if (!m) return null;
  // v8 models (xgboost_trees_data_v8.js) carry their true fitted base score in `b`
  // (a margin; logit for the classifier) and a `link` field. No calibration needed.
  if (m.type === 'linear') {
    // Logistic regression: z = b + sum w * (x - mu) / sd ; missing -> training median.
    let z = m.b;
    for (const f of m.f) {
      const c = m.coef[f];
      let v = Number(dict[f]);
      if (!Number.isFinite(v)) v = c.med;
      z += c.w * ((v - c.mu) / c.sd);
    }
    return sigmoid(z);
  }
  if (m.link) {
    const raw8 = xgbPredictRaw(m, m.f.map(f => dict[f] ?? 0));
    if (m.link === 'logistic') return sigmoid(raw8);
    return name.startsWith('pickup') ? Math.min(0.99, Math.max(0, raw8)) : raw8;
  }
  const raw = xgbPredictRaw(m, m.f.map(f => dict[f] ?? 0));
 
  if (name === 'conversion') {
    return sigmoid(raw + CONVERSION_MARGIN_CORRECTION);
  }
 
  const targetMean = XGB_BASE_SCORE_CORRECTION[name];
  if (targetMean == null) return raw; // unrecognized model name — uncorrected fallback
 
  // raw already includes the exported b=0.5; swap it for the calibrated base.
  const corrected = raw - 0.5 + targetMean;
 
  if (name.startsWith('pickup')) {
    return Math.min(0.99, Math.max(0, corrected)); // a rate — clip, don't sigmoid
  }
  return corrected; // dollars: quoted_adr, fnb
}
 
