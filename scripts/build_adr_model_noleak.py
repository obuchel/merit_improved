"""
build_adr_model.py  (single-file, self-contained)

Runs the real quoted_adr feature-selection + training pipeline end-to-end
and writes the trained model bundle (.pkl) and, optionally, the raw JSON
payload -- no separate pipeline .py file to load, everything the pipeline
needs (join_transient, build_candidate_pool, drop_correlated, prune_vif,
exclude_leaky, prep_X, optuna_search, train_model) lives in this one file.

This is a straight merge of the previous two-file setup
(build_adr_model.py + rfp_adr_pipeline_filtered_first_final.py): every
pipeline function below is copied verbatim from the real pipeline file,
including all four determinism/correctness revisions documented inline
(sorted kept_corr + colsample_bytree=1.0/subsample=1.0/tree_method=exact
for the quick screening model; the SVD rank-deficiency check and the
standardized-VIF fix in prune_vif). Nothing about the algorithms changed
in the merge -- only the import structure (no more importlib/live module
loading).

NEW in this version: optimal top-K selection
==============================================
The old pipeline used a fixed TOP_K = 60 at the importance-screening step
with no justification for that specific number. This version instead:
  1. Runs the same quick-XGBoost importance screening as before (still
     fully deterministic -- same subsample=1.0/colsample_bytree=1.0/
     tree_method="exact" fix).
  2. Sweeps a grid of K cutoffs (TOP_K_GRID below) through the REST of the
     funnel (VIF pruning + leaky exclusion) and evaluates each resulting
     feature set with 5-fold CV MAE, using a FIXED, untuned XGBoost config
     (not a fresh Optuna search per K -- that would be prohibitively slow
     for a sweep this wide; a fixed config isolates the pure effect of K).
  3. Picks the optimal K via the one-standard-error rule (Hastie &
     Tibshirani): among all K within one CV standard error of the best
     mean CV MAE, choose the SMALLEST (simplest model), rather than just
     the single lowest-MAE point, which is often noise.
  4. Saves a plot of CV MAE vs. K (with the chosen K marked) to
     <scratch>/<tag>topk_optimization.png, and the full sweep table to
     <scratch>/<tag>topk_sweep.csv.
This adds real runtime (VIF pruning gets slower at high K) -- expect the
sweep alone to take several minutes on top of the rest of the pipeline.

Usage
=====
pip install xgboost==3.2.0 numpy==2.4.4 pandas==3.0.2 optuna scikit-learn statsmodels matplotlib

python build_adr_model_NEW.py --data rfp_training_data_complete_v3_with_transient.csv --transient-data Nexus_Transient_Demand_v2.csv --out-model adr_model_rebuilt.pkl  --out-json funnel_payload_rebuilt.json

--transient-data is optional: without it, the script uses whatever tr_*
columns are already present in --data (if any) and reports the rest as
"not reconstructable" in the bundle, instead of pretending they exist.
--out-json is also optional -- drop it if you only want the model .pkl.
"""
import argparse
import json
import pickle
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import KFold, cross_val_score, train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from statsmodels.stats.outliers_influence import variance_inflation_factor

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("WARNING: matplotlib not installed -- the top-K optimization plot will be skipped "
          "(the sweep itself, and the CSV table, still run). Install with: pip install matplotlib")

try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except ImportError:
    HAS_OPTUNA = False
    print("WARNING: optuna not installed -- using default hyperparameters for the FINAL model. "
          "Install with: pip install optuna")


# ═══════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════
CORR_THRESHOLD = 0.85
VIF_THRESHOLD  = 10.0
CV_FOLDS       = 5
RANDOM_STATE   = 42
N_OPTUNA       = 30

# Grid swept at the importance-screening stage to choose an optimal top-K
# cutoff, instead of the old fixed TOP_K = 60. Kept deliberately sparser
# than an exhaustive sweep (a dense sweep from 10 to ~190 took ~12-15
# minutes in earlier testing) -- this is a compromise between sweep
# resolution and total pipeline runtime. Values above the number of
# correlation-survivors are dropped automatically at run time.
TOP_K_GRID = [2,5,8,9,10,11,12,13,14,15,16,17,18, 19,20,25, 30, 45, 60, 90, 120, 150]

# Fixed, UNTUNED XGBoost config used only to evaluate the top-K sweep via
# CV MAE -- not the final model's hyperparameters (those still come from
# the real Optuna search in optuna_search()/train_model() below). Using a
# fixed config for the sweep isolates the pure effect of K: re-running a
# full 30-trial Optuna search at every grid point would be far too slow,
# and would also confound "which K is best" with "which K happens to pair
# well with a particular random hyperparameter draw."
TOPK_SWEEP_PARAMS = dict(
    n_estimators=300, max_depth=5, learning_rate=0.05,
    subsample=0.8, colsample_bytree=0.8,
    random_state=RANDOM_STATE, verbosity=0, n_jobs=1,
)

EXCLUDE_RFP_IDS = ["B-202309-62288", "B-202310-34967", "B-202511-72086"]

# Columns always excluded from the candidate feature pool (identity, dates,
# targets, leaky actuals) -- verbatim from the real pipeline.
ALWAYS_EXCLUDE = {
    "rfp_id", "inquiry_date", "arrival_date", "Arrival_Date", "Departure_Date",
    "account_name", "event_name", "status", "lost_reason", "Arrival_DOW_Name",
    "Displacement_Risk_Level", "Demand_Tier", "arrival_dow_name",
    "displacement_risk_level", "demand_tier", "_month", "arrival_week",
    "quoted_adr", "actual_pickup_rate", "actual_fnb_per_person",
    "actual_total_revenue", "is_won", "did_convert", "revenue_realization_pct",
    "Actual_FnB_Revenue", "Actual_FnB_Revenue_v8",
    "Proposed_FnB_Revenue", "Proposed_FnB_Revenue_v8",
    "Arrival_Date_v8", "Departure_Date_v8", "Account_Win_Rate_APIT",
    "fnb_ratio",
    "group_size_tier_enc",
    "market_segment_enc",
}

LEAKY = {
    "quoted_adr": {
        "actual_pickup_rate", "is_won", "did_convert", "win_streak",
        "win_rate_7d", "win_rate_14d", "win_rate_30d", "win_rate_60d", "win_rate_90d",
        "win_rate_ema_30d", "win_rate_ema_7d", "win_rate_ema_90d",
        "win_rate_volatility_30d", "win_rate_volatility_60d", "win_rate_volatility_90d",
        "win_rate_acceleration", "win_rate_momentum",
        "win_rate_velocity_30_90d", "win_rate_velocity_7_30d",
    },
    "pickup":     {"is_won", "did_convert"},
    "conversion": {"actual_pickup_rate"},
    "fnb":        {"actual_pickup_rate", "is_won", "did_convert"},
}


# ── Price-derived columns (added for the no-leak rebuild) ─────────────────────
# These are computed from the row's OWN quoted_adr / proposed revenue (see
# complete_rfp_features_v2.py and build_comprehensive_dataset.py), so they cannot be known before the
# price is set. The original LEAKY list only covered outcome and win-rate columns.
PRICE_DERIVED_EXACT = {
    "rate_discount_pct", "ADR_Discount_Pct", "pricing_pressure_index", "transient_displacement_cost",
    "displacement_ratio", "displacement_occupancy_risk", "Displacement_Risk_Score", "Flag_High_Displacement",
    "revenue_intensity", "Revenue_Per_Room_Night", "expected_value", "risk_adjusted_revenue",
    "opportunity_cost_ratio", "revenue_quality_score", "adr_vs_month_hotel", "rate_ratio",
    "Flag_Rate_Below_Baseline", "proposed_total_revenue", "meeting_ratio", "room_revenue_ratio", "budget_ratio",
    "business_momentum_score", "is_hot_streak", "is_cold_streak", "pattern_complexity", "is_sweet_spot",
    "revenue_intensity_deviation", "estimated_ancillary_revenue", "total_revenue_with_ancillary",
    "rfp_rev_vs_month_avg", "Completeness_Score",
}
PRICE_DERIVED_PREFIX = ("priority_", "avg_revenue_intensity", "revenue_competition", "revenue_ema", "revenue_velocity",
                        "revenue_acceleration", "revenue_momentum", "avg_displacement", "displacement_velocity",
                        "displacement_acceleration", "demand_ema", "confidence_ema")
def is_price_derived(c):
    return c in PRICE_DERIVED_EXACT or c.startswith(PRICE_DERIVED_PREFIX)

IDENTITY_COLS = {
    "rfp_id", "inquiry_date", "arrival_date", "account_name", "event_name",
    "status", "lost_reason", "Arrival_Date", "Departure_Date", "Arrival_DOW_Name",
    "Displacement_Risk_Level", "Demand_Tier", "arrival_dow_name",
    "displacement_risk_level", "demand_tier",
}

TR_NUMERIC = [
    "Transient_ADR", "Market_ADR", "ADR_Index", "Transient_Occ_Of_Available",
    "Total_Occupancy_Pct", "Rooms_to_Capacity", "Transient_Rooms_Turned_Away",
    "Transient_Yield_Pct", "Displacement_Cost_Per_Room", "Pace_Index",
    "Pace_vs_Prior_Year", "Market_Occ_Pct", "Transient_RevPAR",
    "Group_Rooms_On_Books", "Transient_Pace_30d",
]
TR_CAT_MAPS = {
    "tr_demand_tier":           {"Soft": 0, "Low": 1, "Moderate": 2, "High": 3, "Peak": 4},
    "tr_demand_tier_3":         {"Low": 0, "Shoulder": 1, "Peak": 2},
    "tr_rate_strategy":         {"Promotional": 0, "Standard": 1, "Rack": 2,
                                  "Premium_Event": 3, "Holiday_Reduced": -1},
    "tr_displacement_pressure": {"Low": 0, "Medium": 1, "High": 2, "Sold Out": 3},
}

# The original pipeline's candidate pool includes ~19 tr_*-prefixed columns from a
# raw transient-demand time series file. If --transient-data isn't given (or the
# join can't reach some of these), NOT_RECONSTRUCTABLE is computed after loading,
# from whichever expected tr_* columns are actually absent -- nothing here is
# fabricated as a stand-in for a column that isn't genuinely available.
EXPECTED_TR_COLS = [
    "tr_transient_adr", "tr_market_adr", "tr_adr_index", "tr_transient_occ_of_available",
    "tr_total_occupancy_pct", "tr_rooms_to_capacity", "tr_transient_rooms_turned_away",
    "tr_transient_yield_pct", "tr_displacement_cost_per_room", "tr_pace_index",
    "tr_pace_vs_prior_year", "tr_market_occ_pct", "tr_transient_revpar",
    "tr_group_rooms_on_books", "tr_transient_pace_30d",
    "tr_demand_tier", "tr_demand_tier_3", "tr_rate_strategy", "tr_displacement_pressure",
]

OUTPUT_DIR = Path("outputs")  # reassigned by run_pipeline() to the scratch dir


# ═══════════════════════════════════════════════════════════════════════════
# STAGE 2 — TRANSIENT JOIN  (verbatim from the real pipeline)
# ═══════════════════════════════════════════════════════════════════════════
def join_transient(ev, transient_file):
    print("\n[2] Joining transient features over stay window...")
    tr = pd.read_csv(transient_file)
    tr["Date"] = pd.to_datetime(tr["Date"])
    tr_idx = tr.set_index("Date")
    print(f"    Transient: {len(tr):,} rows x {tr.shape[1]} cols")

    def _row(arrival, departure):
        dep = departure if pd.notna(departure) else arrival + pd.Timedelta(days=1)
        dates = pd.date_range(arrival, dep - pd.Timedelta(days=1), freq="D")
        sub = tr_idx.reindex(dates).dropna(how="all")
        row = {}
        for c in TR_NUMERIC:
            row[f"tr_{c.lower()}"] = sub[c].mean() if (len(sub) and c in sub.columns) else np.nan
        for col, mapping in TR_CAT_MAPS.items():
            cat_col = col.replace("tr_", "").replace("_", " ").title().replace(" ", "_")
            match = [c for c in (tr.columns if len(sub) == 0 else sub.columns)
                     if c.lower() == cat_col.lower()]
            if match and len(sub):
                mode = sub[match[0]].dropna().mode()
                row[col] = mode.iloc[0] if len(mode) else np.nan
            else:
                row[col] = np.nan
        return row

    t0 = time.time()
    tr_rows = [_row(r.Arrival_Date, r.Departure_Date) for _, r in ev.iterrows()]
    tr_df = pd.DataFrame(tr_rows, index=ev.index)
    print(f"    Join complete in {time.time()-t0:.1f}s - {tr_df.shape[1]} transient cols")

    for col, mapping in TR_CAT_MAPS.items():
        if col in tr_df.columns:
            tr_df[col] = tr_df[col].map(mapping).fillna(0).astype(int)
    for c in tr_df.select_dtypes("float").columns:
        tr_df[c] = tr_df[c].fillna(tr_df[c].median())

    return pd.concat([ev, tr_df], axis=1)


def real_join_transient(df_raw, transient_path):
    """Real per-row date-window average over the raw daily transient-demand
    time series -- not an approximation. Two adjustments this merged CSV
    needs before it matches what join_transient() expects:
      1. It has lowercase 'arrival_date' but not the capitalized
         'Arrival_Date' join_transient() reads (r.Arrival_Date) -- aliased
         rather than treated as missing, since it's the exact same date.
      2. Any tr_* columns already baked into --data (a prior partial join)
         are dropped first so the freshly-computed, complete columns
         aren't shadowed or duplicated.
    """
    df = df_raw.copy()

    pre_existing_tr = [c for c in df.columns if c.lower().startswith("tr_")]
    if pre_existing_tr:
        print(f"  Dropping {len(pre_existing_tr)} pre-existing (partial) tr_* columns "
              f"before re-joining from the real raw file: {pre_existing_tr}")
        df = df.drop(columns=pre_existing_tr)

    df["Arrival_Date"] = pd.to_datetime(df["Arrival_Date"] if "Arrival_Date" in df.columns else df["arrival_date"])
    df["Departure_Date"] = pd.to_datetime(df["Departure_Date"])

    df_joined = join_transient(df, transient_path)

    new_tr = [c for c in df_joined.columns if c.lower().startswith("tr_") or c in TR_CAT_MAPS]
    print(f"  join_transient() produced {len(new_tr)} tr_* columns from the real raw file.")
    for c in sorted(set(new_tr)):
        miss_pct = df_joined[c].isna().mean() * 100
        print(f"    {c}: {miss_pct:.1f}% missing")
    return df_joined


def engineer_features_full(df):
    """As close to the real engineer_features() as --data allows. What's
    added here is only what's missing: the blanket per-object-column label
    encoding, the group_size_tier split, and the full market_segment
    one-hot set. NOTHING is fabricated for columns --data genuinely doesn't
    have -- those are left NaN and drop out of the candidate pool on
    their own."""
    df = df.copy()

    if "group_size_tier" in df.columns:
        df["is_meeting_only"] = (df["group_size_tier"] == "meeting_only").astype(int)
        size_order = {"small": 0, "medium": 1, "large": 2, "very_large": 3}
        df["group_size_tier_clean_enc"] = df["group_size_tier"].map(size_order).fillna(-1).astype(int)

    if "market_segment" in df.columns:
        ohe = pd.get_dummies(df["market_segment"], prefix="market_seg").astype(int)
        df = pd.concat([df, ohe], axis=1)

    skip_encode = IDENTITY_COLS | {"group_size_tier", "market_segment"}
    for c in df.select_dtypes(include="object").columns:
        if c in skip_encode:
            continue
        df[f"{c}_enc"] = pd.Categorical(df[c]).codes

    if "total_room_nights" not in df.columns:
        df["total_room_nights"] = df.get("room_block", df.get("total_room_nights_requested", np.nan))

    return df


def pearson_r(x, y):
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    mask = ~(np.isnan(x) | np.isnan(y))
    if mask.sum() < 3:
        return None
    xm, ym = x[mask], y[mask]
    if xm.std() < 1e-12 or ym.std() < 1e-12:
        return 0.0
    return float(np.corrcoef(xm, ym)[0, 1])


def spearman_rho(x, y):
    x = pd.Series(x).rank()
    y = pd.Series(y).rank()
    return pearson_r(x.values, y.values)


def jsonable(v):
    if v is None:
        return None
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if (np.isnan(v) or np.isinf(v)) else round(float(v), 6)
    return str(v)


# ═══════════════════════════════════════════════════════════════════════════
# STAGE 4 — CANDIDATE POOL  (verbatim from the real pipeline)
# ═══════════════════════════════════════════════════════════════════════════
def build_candidate_pool(ev):
    print("\n[4] Building candidate feature pool...")
    numeric = ev.select_dtypes(include=[np.number]).columns.tolist()
    pool = [
        c for c in numeric
        if c not in ALWAYS_EXCLUDE
        and not is_price_derived(c)
        and not c.endswith("_v8")
        and ev[c].std() > 1e-10
        and ev[c].isna().mean() < 0.50
    ]
    for c in pool:
        med = ev[c].median()
        ev[c] = ev[c].fillna(med if not np.isnan(med) else 0)
        ev[c] = ev[c].replace([np.inf, -np.inf], med if not np.isnan(med) else 0)
    print(f"    Candidate pool: {len(pool)} features")
    return pool


# ═══════════════════════════════════════════════════════════════════════════
# STAGE 5 — MULTICOLLINEARITY PRUNING  (verbatim from the real pipeline,
# including all four determinism/correctness revisions documented in the
# original file's CHANGE LOG)
# ═══════════════════════════════════════════════════════════════════════════
def drop_correlated(X, threshold=CORR_THRESHOLD):
    corr = X.corr().abs()
    removed, log = set(), []
    for i in range(len(corr.columns)):
        for j in range(i + 1, len(corr.columns)):
            c1, c2 = corr.columns[i], corr.columns[j]
            if c1 in removed or c2 in removed:
                continue
            r = corr.iloc[i, j]
            if r >= threshold:
                drop = c2 if X[c1].std() >= X[c2].std() else c1
                keep = c1 if drop == c2 else c2
                removed.add(drop)
                log.append({"kept": keep, "dropped": drop, "correlation": round(float(r), 4)})
    return [c for c in X.columns if c not in removed], pd.DataFrame(log)


def prune_vif(X, threshold=VIF_THRESHOLD, rank_eps=1e-8):
    """Revision 3: detects exact/near-exact rank deficiency via SVD before
    trusting variance_inflation_factor()'s output (a genuine singularity
    otherwise makes the VIF numerically arbitrary and flips pruning
    outcomes run-to-run). Revision 4: standardizes the matrix itself before
    every VIF call, so the result doesn't silently depend on which
    statsmodels version happens to be installed (VIF is scale-invariant in
    theory, but statsmodels 0.15.0 vs 0.14.5 disagree on whether to
    standardize internally)."""
    cols, vif_log = list(X.columns), []
    while True:
        Xm = X[cols].copy()
        for c in Xm.columns:
            m = Xm[c].median()
            Xm[c] = Xm[c].replace([np.inf, -np.inf], np.nan).fillna(m if not pd.isna(m) else 0)
        ok = [c for c in cols if Xm[c].std() > 1e-10]
        if len(ok) < 2:
            break
        Xm = Xm[ok]

        Xstd = (Xm - Xm.mean()) / Xm.std()
        sv = np.linalg.svd(Xstd.values, compute_uv=False)
        if sv[-1] < rank_eps * sv[0]:
            _, _, vt = np.linalg.svd(Xstd.values, full_matrices=False)
            worst_idx = int(np.argmax(np.abs(vt[-1])))
            worst = ok[worst_idx]
            vif_log.append({"feature": worst, "vif": float("inf")})
            cols = [c for c in cols if c != worst]
            continue

        vifs = [variance_inflation_factor(Xstd.values, k) for k in range(len(ok))]
        vs = pd.Series(vifs, index=ok)
        worst, wval = vs.idxmax(), vs.max()
        if wval <= threshold:
            break
        vif_log.append({"feature": worst, "vif": round(wval, 2)})
        cols = [c for c in cols if c != worst]
    if len(cols) >= 2:
        Xm = X[cols].copy()
        for c in Xm.columns:
            m = Xm[c].median()
            Xm[c] = Xm[c].replace([np.inf, -np.inf], np.nan).fillna(m if not pd.isna(m) else 0)
        ok = [c for c in cols if Xm[c].std() > 1e-10]
        Xm = Xm[ok]
        Xstd_final = (Xm - Xm.mean()) / Xm.std()
        final_vif = pd.DataFrame({
            "feature": ok,
            "vif": [variance_inflation_factor(Xstd_final.values, k) for k in range(len(ok))],
        }).sort_values("vif", ascending=False)
    else:
        final_vif = pd.DataFrame(columns=["feature", "vif"])
    return cols, final_vif, pd.DataFrame(vif_log)


def exclude_leaky(features, model_name):
    ll = {x.lower() for x in LEAKY.get(model_name, set())}
    return [f for f in features if f.lower() not in ll]


# ═══════════════════════════════════════════════════════════════════════════
# NEW — optimal top-K selection at the importance-screening stage
# ═══════════════════════════════════════════════════════════════════════════
def sweep_top_k(ev, kept_corr, imp_series, target, model_name, tag, grid=None,
                 inner_folds=None, verbose=True, make_plot=True):
    """Sweeps TOP_K_GRID (or `grid`) through VIF pruning + leaky exclusion,
    evaluates each resulting feature set with 5-fold CV MAE under a FIXED
    XGBoost config (see TOPK_SWEEP_PARAMS -- this is deliberately NOT a
    fresh Optuna search per K, for runtime reasons; it isolates the pure
    effect of K), and picks the optimal K via the one-standard-error rule:
    among all K within one CV std of the single best mean CV MAE, choose
    the smallest (simplest model), rather than just the raw minimum, which
    is often noise given the CV fold-to-fold spread.

    `inner_folds`, `verbose`, and `make_plot` default to the original
    behavior (CV_FOLDS folds, full printing, plot written) so every existing
    call site is unaffected. nested_cv_evaluate() below is the only caller
    that overrides them, to re-run this sweep quietly and cheaply inside
    each outer fold.

    Returns (optimal_k, sweep_df, plot_path).
    """
    grid = grid or TOP_K_GRID
    grid = sorted(set(k for k in grid if k <= len(kept_corr)) | {len(kept_corr)})
    folds = inner_folds or CV_FOLDS
    if verbose:
        print(f"\n    Top-K sweep over {grid} (of {len(kept_corr)} correlation-survivors)...")

    y = ev[target].astype(float).values
    cv = KFold(folds, shuffle=True, random_state=RANDOM_STATE)

    rows = []
    for k in grid:
        t0 = time.time()
        top_k = imp_series.head(k).index.tolist()
        kept_vif, _, _ = prune_vif(ev[top_k])
        final_feats = exclude_leaky(kept_vif, model_name)
        af = [f for f in final_feats if f in ev.columns]
        X = prep_X(ev, af)
        cv_sc = cross_val_score(
            xgb.XGBRegressor(**TOPK_SWEEP_PARAMS), X, y,
            cv=cv, scoring="neg_mean_absolute_error", n_jobs=1,
        )
        mae_mean, mae_std = float(-cv_sc.mean()), float(cv_sc.std())
        rows.append({"top_k_cutoff": k, "final_feature_count": len(af),
                      "cv_mae_mean": mae_mean, "cv_mae_std": mae_std})
        if verbose:
            print(f"      K={k:>4d}  -> {len(af):>3d} final features  "
                  f"CV MAE=${mae_mean:.3f} +/- {mae_std:.3f}  ({time.time()-t0:.1f}s)")

    sweep_df = pd.DataFrame(rows)
    sweep_df.to_csv(OUTPUT_DIR / f"{tag}topk_sweep.csv", index=False)

    best_idx = sweep_df["cv_mae_mean"].idxmin()
    threshold = sweep_df.loc[best_idx, "cv_mae_mean"] + sweep_df.loc[best_idx, "cv_mae_std"]
    within_1se = sweep_df[sweep_df["cv_mae_mean"] <= threshold]
    optimal_k = int(within_1se["top_k_cutoff"].min())
    if verbose:
        print(f"    Best raw CV MAE at K={int(sweep_df.loc[best_idx, 'top_k_cutoff'])} "
              f"(${sweep_df.loc[best_idx, 'cv_mae_mean']:.3f}); "
              f"1-SE rule (<=${threshold:.3f}) selects K={optimal_k} "
              f"({int(sweep_df[sweep_df['top_k_cutoff']==optimal_k]['final_feature_count'].iloc[0])} final features)")

    plot_path = None
    if HAS_MATPLOTLIB and make_plot:
        fig, ax = plt.subplots(figsize=(8, 5), dpi=150)
        ax.plot(sweep_df["top_k_cutoff"], sweep_df["cv_mae_mean"], "o-",
                color="#2a78d6", label="CV MAE")
        ax.fill_between(sweep_df["top_k_cutoff"],
                         sweep_df["cv_mae_mean"] - sweep_df["cv_mae_std"],
                         sweep_df["cv_mae_mean"] + sweep_df["cv_mae_std"],
                         color="#2a78d6", alpha=0.15, label="+/- 1 CV std")
        ax.axhline(threshold, color="#999999", linestyle="--", linewidth=1,
                    label=f"1-SE threshold (${threshold:.2f})")
        chosen_row = sweep_df[sweep_df["top_k_cutoff"] == optimal_k].iloc[0]
        ax.scatter([optimal_k], [chosen_row["cv_mae_mean"]], color="#e34948", s=110,
                   zorder=5, label=f"Chosen K={optimal_k}")
        ax.set_xlabel("Top-K cutoff (importance screening)")
        ax.set_ylabel("5-fold CV MAE ($)")
        ax.set_title(f"Optimal top-K selection — {model_name}")
        ax.legend(frameon=False, fontsize=9)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        fig.tight_layout()
        plot_path = OUTPUT_DIR / f"{tag}topk_optimization.png"
        fig.savefig(plot_path)
        plt.close(fig)
        if verbose:
            print(f"    Wrote {plot_path}")

    return optimal_k, sweep_df, plot_path


def prune_features(ev, pool, target="quoted_adr", model_name="quoted_adr", tag=""):
    """Correlation pruning -> quick-XGBoost importance screening ->
    OPTIMAL top-K selection (new; replaces the old fixed TOP_K=60) ->
    VIF pruning. Returns (kept_vif_features, optimal_k, sweep_df, plot_path)."""
    print("\n[5] Multicollinearity pruning...")
    X_all = ev[pool].copy()

    print(f"    Correlation pruning (r >= {CORR_THRESHOLD})...")
    t0 = time.time()
    kept_corr, corr_log = drop_correlated(X_all)
    print(f"    {len(pool)} -> {len(kept_corr)}  ({len(corr_log)} pairs, {time.time()-t0:.1f}s)")
    corr_log.to_csv(OUTPUT_DIR / f"{tag}multicollinearity_correlation_pairs.csv", index=False)

    # Pin kept_corr to a fixed (alphabetical) column order before it's used to
    # build X_proxy -- see the real pipeline's CHANGE LOG for why (colsample_bytree
    # samples columns by index position, so an incidental order otherwise
    # silently steers the result).
    kept_corr = sorted(kept_corr)

    print("    Importance screening (quick, deterministic proxy model)...")
    y_proxy = ev[target].values
    X_proxy = ev[kept_corr].copy().astype(float)
    quick = xgb.XGBRegressor(
        n_estimators=100, max_depth=5, learning_rate=0.1,
        # subsample=1.0, colsample_bytree=1.0, tree_method="exact": every tree
        # sees the full, identical input, with no histogram/quantile
        # approximation step -- removes cross-platform and same-machine
        # non-determinism (see the real pipeline's CHANGE LOG revisions 1-2).
        subsample=1.0, colsample_bytree=1.0, tree_method="exact",
        random_state=RANDOM_STATE, verbosity=0, n_jobs=1,
    )
    quick.fit(X_proxy, y_proxy)
    imp_series = pd.Series(quick.feature_importances_, index=kept_corr).sort_values(ascending=False)
    imp_series.to_csv(OUTPUT_DIR / f"{tag}importance_pool_screening.csv", header=["importance"])

    optimal_k, sweep_df, plot_path = sweep_top_k(ev, kept_corr, imp_series, target, model_name, tag)

    top_k = imp_series.head(optimal_k).index.tolist()

    print(f"    VIF pruning (VIF >= {VIF_THRESHOLD}) on top-{optimal_k}...")
    t0 = time.time()
    kept_vif, vif_final, vif_log = prune_vif(ev[top_k])
    print(f"    {optimal_k} -> {len(kept_vif)}  ({len(vif_log)} removed, {time.time()-t0:.1f}s)")
    vif_final.to_csv(OUTPUT_DIR / f"{tag}multicollinearity_vif_final.csv", index=False)
    if len(vif_log):
        vif_log.to_csv(OUTPUT_DIR / f"{tag}multicollinearity_vif_removed.csv", index=False)

    print(f"\n    Base feature pool: {len(kept_vif)} features")
    return kept_vif, optimal_k, sweep_df, plot_path


# ═══════════════════════════════════════════════════════════════════════════
# STAGE 6 — TRAIN  (verbatim from the real pipeline)
# ═══════════════════════════════════════════════════════════════════════════
def prep_X(df, features):
    X = df[features].copy()
    for c in X.columns:
        X[c] = pd.to_numeric(X[c], errors="coerce")
        X[c] = X[c].fillna(X[c].median() if X[c].notna().any() else 0)
    return X.astype(float)


def optuna_search(X_tr, y_tr, is_clf=False, n_trials=None, cv_folds=None, random_state=None):
    """`n_trials`, `cv_folds`, and `random_state` default to the module-level
    N_OPTUNA/CV_FOLDS/RANDOM_STATE (the original behavior, used by
    train_model() below for the actual production model) so every existing
    call site is unaffected. nested_cv_evaluate() is the only caller that
    overrides them, to re-tune with fewer trials/folds inside each outer
    fold and keep nested CV's runtime bounded."""
    n_trials = N_OPTUNA if n_trials is None else n_trials
    cv_folds = CV_FOLDS if cv_folds is None else cv_folds
    rs = RANDOM_STATE if random_state is None else random_state
    if not HAS_OPTUNA:
        return {
            "n_estimators": 200, "max_depth": 5, "learning_rate": 0.05,
            "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 3,
            "reg_alpha": 0.5, "reg_lambda": 1.5,
            "random_state": rs, "verbosity": 0, "n_jobs": 1,
        }
    cv = KFold(cv_folds, shuffle=True, random_state=rs)

    def objective(trial):
        p = {
            "n_estimators":     trial.suggest_int("n_estimators", 50, 400),
            "max_depth":        trial.suggest_int("max_depth", 3, 8),
            "learning_rate":    trial.suggest_float("learning_rate", 0.005, 0.2, log=True),
            "subsample":        trial.suggest_float("subsample", 0.5, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.4, 1.0),
            "min_child_weight": trial.suggest_int("min_child_weight", 1, 10),
            "reg_alpha":        trial.suggest_float("reg_alpha", 0.0, 2.0),
            "reg_lambda":       trial.suggest_float("reg_lambda", 0.5, 5.0),
            "random_state": rs, "verbosity": 0, "n_jobs": 1,
        }
        if is_clf:
            p["gamma"] = trial.suggest_float("gamma", 0.0, 1.0)
        return -cross_val_score(
            xgb.XGBRegressor(**p), X_tr, y_tr,
            cv=cv, scoring="neg_mean_absolute_error", n_jobs=1,
        ).mean()

    study = optuna.create_study(
        direction="minimize",
        sampler=optuna.samplers.TPESampler(seed=rs),
    )
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
    bp = study.best_params
    bp.update({"random_state": rs, "verbosity": 0, "n_jobs": 1})
    return bp


# ═══════════════════════════════════════════════════════════════════════════
# NEW — nested CV: an honest, leakage-free generalization estimate
# ═══════════════════════════════════════════════════════════════════════════
def nested_cv_evaluate(ev, kept_corr, target="quoted_adr", model_name="quoted_adr",
                        tag="rebuilt_", outer_folds=5, inner_folds=5,
                        n_optuna_inner=15, topk_grid=None, random_state=RANDOM_STATE,
                        verbose=True):
    """Honest, leakage-free estimate of this pipeline's real generalization,
    accounting for the fact that BOTH the top-K feature-count cutoff and the
    Optuna hyperparameters are themselves chosen BY cross-validation, not
    fixed in advance.

    Why the single train/test-split numbers train_model() reports are
    optimistic in a specific, easy-to-miss way: sweep_top_k() picks K using
    CV MAE computed over the WHOLE population (`ev`, before any train/test
    split exists), and only THEN does train_model() split off a test set and
    tune hyperparameters on the training side of that split. By the time K
    was chosen, the eventual test rows' own signal was already part of the
    score that picked it -- a real, if subtle, form of feature-selection
    leakage. The reported test_mae/test_r2 describe a model whose feature
    COUNT was implicitly fit on data overlapping the rows used to "test" it.

    Nested CV closes that gap. For each of `outer_folds` folds: the fold's
    own test rows are held out completely untouched; the importance-
    screening ranking, the top-K sweep (its own `inner_folds`-fold CV), VIF
    pruning, and leaky exclusion are ALL re-run from scratch using ONLY that
    fold's training rows; hyperparameters are re-tuned via Optuna
    (`n_optuna_inner` trials, again via `inner_folds`-fold CV on the fold's
    training rows only); a model is fit on the FULL fold training set with
    those choices; and it is scored ONCE on the fold's held-out test rows,
    which never influenced any choice made about it. Averaging the
    outer-fold test scores is the textbook nested-CV estimator (Cawley &
    Talbot, 2010) for when model/feature selection is itself tuned by CV.

    SCOPE, deliberately, mirrors the classification pipeline's
    nested_cv_evaluate(): `kept_corr` (the correlation-pruned candidate
    pool) is passed in from the already-computed full-data run and is NOT
    re-derived per fold. Candidate-pool construction and correlation pruning
    are purely structural checks on X alone (std, missingness, pairwise |r|)
    that never look at y, so they carry essentially none of the leakage risk
    that K-selection and hyperparameter tuning do -- both of THOSE are
    explicitly chosen by scoring candidate choices against y via CV, which is
    exactly the mechanism nested CV exists to correct for. Everything that
    DOES use y to make a choice is redone inside each outer fold on that
    fold's training rows only.

    This does NOT replace or change the production model from train_model()
    below (still trained on the full population, and still what actually
    gets deployed) -- it only reports how much to trust that model's
    headline metrics. Expensive: roughly
    outer_folds * (len(topk_grid)*inner_folds + n_optuna_inner*inner_folds)
    XGBoost fits -- e.g. the defaults give 5 * (14*5 + 15*5) = 725 fits, on
    top of the pipeline's normal run. Call only when you want this honest
    number, not on every iteration during development.

    Returns (fold_results_df, summary_dict).
    """
    topk_grid = topk_grid or TOP_K_GRID
    y_full = ev[target].astype(float).values
    outer_cv = KFold(outer_folds, shuffle=True, random_state=random_state)

    if verbose:
        print(f"\n    Nested CV: {outer_folds} outer folds, {inner_folds}-fold inner CV for "
              f"both K-selection and hyperparameter tuning ({n_optuna_inner} Optuna trials/fold)...")

    fold_rows = []
    for fold_i, (tr_idx, te_idx) in enumerate(outer_cv.split(ev), start=1):
        t0 = time.time()
        ev_tr = ev.iloc[tr_idx].reset_index(drop=True)
        ev_te = ev.iloc[te_idx].reset_index(drop=True)
        y_tr_full = ev_tr[target].astype(float).values

        # Re-derive the importance-screening ranking on THIS fold's training
        # rows only -- it touches y, so it must be inside the outer fold.
        X_proxy = ev_tr[kept_corr].copy().astype(float)
        quick = xgb.XGBRegressor(
            n_estimators=100, max_depth=5, learning_rate=0.1,
            subsample=1.0, colsample_bytree=1.0, tree_method="exact",
            random_state=random_state, verbosity=0, n_jobs=1,
        )
        quick.fit(X_proxy, y_tr_full)
        imp_series = pd.Series(quick.feature_importances_, index=kept_corr).sort_values(ascending=False)

        # Re-select K on THIS fold's training rows only, via its own inner CV.
        fold_tag = f"{tag}nestedcv_fold{fold_i}_"
        optimal_k, _sweep_df, _plot = sweep_top_k(
            ev_tr, kept_corr, imp_series, target, model_name, fold_tag,
            grid=topk_grid, inner_folds=inner_folds, verbose=False, make_plot=False,
        )
        top_k = imp_series.head(optimal_k).index.tolist()

        # VIF prune + leaky exclusion, both driven by the fold-local K choice.
        kept_vif, _vif_final, _vif_log = prune_vif(ev_tr[top_k])
        feats = exclude_leaky(kept_vif, model_name)
        feats = [f for f in feats if f in ev_tr.columns]

        # Re-tune hyperparameters on THIS fold's training rows only, via its
        # own inner CV -- fewer trials than the production N_OPTUNA to keep
        # nested CV's total runtime bounded (outer_folds * n_optuna_inner
        # trials is already a large multiple of a single Optuna search).
        X_tr = prep_X(ev_tr, feats)
        bp = optuna_search(X_tr, y_tr_full, is_clf=False,
                            n_trials=n_optuna_inner, cv_folds=inner_folds,
                            random_state=random_state)

        model = xgb.XGBRegressor(**bp)
        model.fit(X_tr, y_tr_full)

        X_te = prep_X(ev_te, feats)
        y_te = ev_te[target].astype(float).values
        pred_te = model.predict(X_te)

        fold_metrics = {
            "fold": fold_i, "optimal_k": optimal_k, "n_features": len(feats),
            "n_train": len(ev_tr), "n_test": len(ev_te),
            "test_mae": float(mean_absolute_error(y_te, pred_te)),
            "test_r2": float(r2_score(y_te, pred_te)),
        }
        if verbose:
            print(f"      outer fold {fold_i}/{outer_folds}: K={optimal_k} -> {len(feats)} features  "
                  f"test MAE=${fold_metrics['test_mae']:.2f}  "
                  f"test R2={fold_metrics['test_r2']:.4f}  ({time.time()-t0:.0f}s)")
        fold_rows.append(fold_metrics)

    fold_df = pd.DataFrame(fold_rows)
    metric_cols = ["test_mae", "test_r2"]
    summary = {col: {"mean": float(fold_df[col].mean()), "std": float(fold_df[col].std())}
               for col in metric_cols}
    summary["k_chosen_per_fold"] = fold_df["optimal_k"].tolist()
    summary["outer_folds"] = outer_folds
    summary["inner_folds"] = inner_folds
    summary["n_optuna_inner"] = n_optuna_inner
    fold_df.to_csv(OUTPUT_DIR / f"{tag}nested_cv_results.csv", index=False)

    if verbose:
        print(f"\n    Nested CV honest estimate over {outer_folds} outer folds "
              f"(K-selection + hyperparameter tuning both re-run per fold, "
              f"never seeing that fold's test rows):")
        print(f"      MAE  ${summary['test_mae']['mean']:.2f} +/- {summary['test_mae']['std']:.2f}")
        print(f"      R2    {summary['test_r2']['mean']:.4f} +/- {summary['test_r2']['std']:.4f}")
        print(f"      K chosen per outer fold: {summary['k_chosen_per_fold']}")

    return fold_df, summary


def train_model(name, ev, features, target,
                is_clf=False, filter_booked=False, positive_only=False,
                filter_rooms=False, scale_pos_weight=None):
    print(f"\n{'-'*60}")
    print(f"  {name}")
    print(f"{'-'*60}")

    df = ev.copy()
    if filter_booked:
        df = df[df["status"] == "Booked"]
    if positive_only:
        df = df[df[target] > 0]
    if filter_rooms:
        before = len(df)
        df = df[df["room_block"] > 0]
        print(f"  [FIX 1] Filtered room_block>0: {before} -> {len(df)} rows "
              f"({before-len(df)} meeting-only records excluded)")
    df = df[df[target].notna()]

    af = [f for f in features if f in df.columns]
    X  = prep_X(df, af)
    y  = df[target].values

    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.20,
        stratify=(y > y.mean()).astype(int) if is_clf else None,
        random_state=RANDOM_STATE,
    )
    print(f"  n={len(df):,}  train={len(X_tr)}  test={len(X_te)}  features={len(af)}")

    t0 = time.time()
    print(f"  Hyperparameter search ({N_OPTUNA} Optuna trials)..." if HAS_OPTUNA
          else "  Using fixed default hyperparameters (optuna not installed)...")
    bp = optuna_search(X_tr, y_tr, is_clf)

    if scale_pos_weight is not None:
        bp["scale_pos_weight"] = scale_pos_weight

    print(f"  Best: n_est={bp['n_estimators']} depth={bp['max_depth']} "
          f"lr={bp['learning_rate']:.4f}  ({time.time()-t0:.0f}s)")

    model = xgb.XGBRegressor(**bp)
    model.fit(X_tr, y_tr)

    pred_tr = model.predict(X_tr)
    pred_te = model.predict(X_te)

    cv = KFold(CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    cv_sc = cross_val_score(
        xgb.XGBRegressor(**bp), X, y,
        cv=cv, scoring="neg_mean_absolute_error", n_jobs=1,
    )

    metrics = {
        "train_mae": float(mean_absolute_error(y_tr, pred_tr)),
        "test_mae":  float(mean_absolute_error(y_te, pred_te)),
        "train_r2":  float(r2_score(y_tr, pred_tr)),
        "test_r2":   float(r2_score(y_te, pred_te)),
    }
    print(f"  MAE {metrics['train_mae']:.4f}/{metrics['test_mae']:.4f}  "
          f"R2 {metrics['train_r2']:.4f}/{metrics['test_r2']:.4f}")

    metrics["cv_mae_mean"] = float(-cv_sc.mean())
    metrics["cv_mae_std"]  = float(cv_sc.std())
    metrics["n_train"]     = len(X_tr)
    metrics["n_test"]      = len(X_te)
    print(f"  CV MAE {metrics['cv_mae_mean']:.4f} +/- {metrics['cv_mae_std']:.4f}")

    imp = pd.DataFrame({"feature": af, "importance": model.feature_importances_})
    imp = imp.sort_values("importance", ascending=False)
    imp["importance_pct"] = imp["importance"] / imp["importance"].sum() * 100
    imp["rank"] = range(1, len(imp) + 1)

    print("\n  Top 15 features:")
    for _, r in imp.head(15).iterrows():
        print(f"    {int(r['rank']):>2}. {r['feature']:<44} {r['importance_pct']:>6.2f}%")

    return {"model": model, "features": af, "metrics": metrics,
            "importance": imp, "best_params": bp}


# ═══════════════════════════════════════════════════════════════════════════
# STAGE A — run the whole pipeline and build the JSON payload
# ═══════════════════════════════════════════════════════════════════════════
def run_pipeline(data_path, transient_path, scratch_dir,
                  nested_cv=False, nested_cv_outer_folds=5, nested_cv_inner_folds=5,
                  nested_cv_n_optuna=15):
    global OUTPUT_DIR
    scratch = Path(scratch_dir)
    scratch.mkdir(exist_ok=True, parents=True)
    OUTPUT_DIR = scratch

    print("Loading raw data...")
    df_raw = pd.read_csv(data_path)
    df_raw["rfp_id"] = df_raw["rfp_id"].astype(str)

    if transient_path:
        print(f"\nJoining REAL transient-demand data from {transient_path}...")
        df_raw = real_join_transient(df_raw, transient_path)

    print("\nEngineering features on the FULL population first (so categorical codes / "
          "one-hot columns are derived once, consistently, before any row is split off)...")
    df_eng = engineer_features_full(df_raw)
    not_reconstructable = [c for c in EXPECTED_TR_COLS if c not in df_eng.columns]
    print(f"  tr_* columns not reconstructable ({len(not_reconstructable)}): {not_reconstructable}")

    print(f"Excluding {len(EXCLUDE_RFP_IDS)} flagged rows: {EXCLUDE_RFP_IDS}")
    missing = set(EXCLUDE_RFP_IDS) - set(df_eng["rfp_id"])
    if missing:
        print(f"  WARNING: not found: {sorted(missing)}")
    ev = df_eng[~df_eng["rfp_id"].isin(EXCLUDE_RFP_IDS)].reset_index(drop=True)
    excl_df = df_eng[df_eng["rfp_id"].isin(EXCLUDE_RFP_IDS)].reset_index(drop=True)
    rows_before_filter = len(ev)

    print(">>> Filtering room_block > 0 BEFORE pool/pruning (filter-first).")
    ev_adr = ev[ev["room_block"] > 0].copy().reset_index(drop=True)
    rows_after_filter = len(ev_adr)
    rows_excluded = rows_before_filter - rows_after_filter
    print(f"  {rows_before_filter} -> {rows_after_filter} rows ({rows_excluded} meeting-only rows excluded)")

    print("\n[Stage: candidate pool]")
    pool = build_candidate_pool(ev_adr)

    print("\n[Stage: correlation pruning + importance screening + optimal-K selection + VIF pruning]")
    base, optimal_k, sweep_df, plot_path = prune_features(
        ev_adr, pool, target="quoted_adr", model_name="quoted_adr", tag="rebuilt_"
    )

    print("\n[Stage: leaky-feature exclusion]")
    adr_feats = exclude_leaky(base, "quoted_adr")
    dropped_leaky = sorted(set(base) - set(adr_feats))
    print(f"  Leaky-excluded: {dropped_leaky if dropped_leaky else '(none)'}")
    print(f"  Final feature list: {len(adr_feats)} features")

    print("\n[Stage: train final model — Optuna search]")
    result = train_model("Quoted ADR (rebuilt, outliers excluded)", ev, adr_feats,
                          "quoted_adr", filter_rooms=True)

    corr_log = pd.read_csv(scratch / "rebuilt_multicollinearity_correlation_pairs.csv")
    imp_screen = pd.read_csv(scratch / "rebuilt_importance_pool_screening.csv")
    imp_screen.columns = ["feature", "importance"]
    vif_final = pd.read_csv(scratch / "rebuilt_multicollinearity_vif_final.csv")
    vif_removed_path = scratch / "rebuilt_multicollinearity_vif_removed.csv"
    vif_removed = pd.read_csv(vif_removed_path) if vif_removed_path.exists() else pd.DataFrame(columns=["feature", "vif"])

    kept_corr = sorted([c for c in pool if c not in set(corr_log["dropped"])])
    top_k_list = imp_screen.sort_values("importance", ascending=False).head(optimal_k)["feature"].tolist()

    nested_cv_summary = None
    if nested_cv:
        print("\n[Stage: nested CV — honest generalization estimate]")
        _nested_fold_df, nested_cv_summary = nested_cv_evaluate(
            ev_adr, kept_corr, target="quoted_adr", model_name="quoted_adr", tag="rebuilt_",
            outer_folds=nested_cv_outer_folds, inner_folds=nested_cv_inner_folds,
            n_optuna_inner=nested_cv_n_optuna,
        )

    y_all = ev_adr["quoted_adr"].astype(float).values
    stats = {}
    points = {"quoted_adr": [jsonable(v) for v in y_all]}
    for feat in pool:
        xv = pd.to_numeric(ev_adr[feat], errors="coerce").values.astype(float)
        stats[feat] = {
            "pearson_r": pearson_r(xv, y_all),
            "spearman_rho": spearman_rho(xv, y_all),
            "nunique": int(pd.Series(xv).nunique()),
            "is_binary": bool(pd.Series(xv).nunique() <= 2),
        }
        points[feat] = [jsonable(v) for v in xv]

    for feat in ["rate_discount_pct", "lead_time_days", "account_avg_revenue", "account_win_rate",
                 "segment_win_rate", "attendees", "room_block", "nights"]:
        if feat in ev_adr.columns and feat not in points:
            points[feat] = [jsonable(v) for v in ev_adr[feat]]

    is_excluded_flags = [False] * len(ev_adr)
    if len(excl_df):
        X_excl = prep_X(excl_df, adr_feats)
        pred_excl = result["model"].predict(X_excl)
        points["quoted_adr"] += [jsonable(v) for v in excl_df["quoted_adr"].astype(float)]
        for feat in pool:
            if feat in excl_df.columns:
                xv = pd.to_numeric(excl_df[feat], errors="coerce").values.astype(float)
            else:
                xv = np.full(len(excl_df), np.nan)
            points[feat] += [jsonable(v) for v in xv]
        for feat in ["rate_discount_pct", "lead_time_days", "account_avg_revenue", "account_win_rate",
                     "segment_win_rate", "attendees", "room_block", "nights"]:
            if feat in points:
                if feat in excl_df.columns:
                    points[feat] += [jsonable(v) for v in excl_df[feat]]
                else:
                    points[feat] += [None] * len(excl_df)
        points["predicted_adr_excluded"] = [None] * len(ev_adr) + [jsonable(v) for v in pred_excl]
        points["rfp_id"] = [None] * len(ev_adr) + list(excl_df["rfp_id"])
        is_excluded_flags += [True] * len(excl_df)
    points["is_excluded_from_training"] = is_excluded_flags

    final_importance = result["importance"][["feature", "importance", "importance_pct", "rank"]].to_dict("records")

    funnel = {
        "rows_before_filter": int(rows_before_filter),
        "rows_after_filter": int(rows_after_filter),
        "rows_excluded": int(rows_excluded),
        "excluded_rfp_ids": EXCLUDE_RFP_IDS,
        "not_reconstructable_features": not_reconstructable,
        "pool": pool,
        "pool_size": len(pool),
        "corr_pairs": corr_log.to_dict("records"),
        "kept_corr": kept_corr,
        "kept_corr_size": len(kept_corr),
        "importance_screening": imp_screen.sort_values("importance", ascending=False).to_dict("records"),
        "topk_optimal": optimal_k,
        "topk_sweep": sweep_df.to_dict("records"),
        "topk_plot_path": str(plot_path) if plot_path else None,
        "top60": top_k_list,  # kept key name "top60" for downstream-page compatibility; holds the OPTIMAL-K list now
        "vif_removed": [
            {"feature": r["feature"], "vif": ("inf" if (isinstance(r["vif"], str) or np.isinf(r["vif"])) else round(float(r["vif"]), 2))}
            for r in vif_removed.to_dict("records")
        ],
        "vif_final": vif_final.to_dict("records"),
        "vif_final_size": len(vif_final),
        "leaky_dropped": dropped_leaky,
        "adr_feats": adr_feats,
        "adr_feats_size": len(adr_feats),
        "final_importance": final_importance,
        "metrics": result["metrics"],
        "best_params": result["best_params"],
        "nested_cv": nested_cv_summary,
    }

    payload = {
        "funnel": funnel,
        "stats": stats,
        "adr_mean": float(np.mean(y_all)),
        "adr_std": float(np.std(y_all)),
        "points": points,
    }

    bundle = {
        "model": result["model"],
        "features": result["features"],
        "target": "quoted_adr",
        "best_params": result["best_params"],
        "metrics": result["metrics"],
        "candidate_pool_size": len(pool),
        "base_pool_size": len(base),
        "topk_optimal": optimal_k,
        "leaky_dropped": dropped_leaky,
        "excluded_rfp_ids": EXCLUDE_RFP_IDS,
        "not_reconstructable_features": not_reconstructable,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "library_versions": {"xgboost": xgb.__version__, "pandas": pd.__version__, "numpy": np.__version__},
        "nested_cv_summary": nested_cv_summary,
    }

    print(f"\nFinal: optimal_K={optimal_k} | {len(adr_feats)} features | "
          f"test_r2={result['metrics']['test_r2']:.4f} | test_mae=${result['metrics']['test_mae']:.2f}")
    if nested_cv_summary:
        print(f"  Single-split (optimistic):  test_mae=${result['metrics']['test_mae']:.2f}  "
              f"test_r2={result['metrics']['test_r2']:.4f}")
        print(f"  Nested CV (honest estimate): test_mae=${nested_cv_summary['test_mae']['mean']:.2f} "
              f"+/- {nested_cv_summary['test_mae']['std']:.2f}  "
              f"test_r2={nested_cv_summary['test_r2']['mean']:.4f} "
              f"+/- {nested_cv_summary['test_r2']['std']:.4f}")

    return payload, bundle


# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True,
                     help="rfp_training_data_complete_v3_with_transient.csv (the merged training CSV)")
    ap.add_argument("--transient-data", default=None,
                     help="Raw transient-demand CSV (e.g. Nexus_Transient_Demand_v2.csv). Optional -- "
                          "omit to use whatever tr_* columns --data already has.")
    ap.add_argument("--out-model", required=True, help="Output path for the trained model bundle (.pkl)")
    ap.add_argument("--out-json", default=None, help="Optional: also write the raw JSON payload")
    ap.add_argument("--scratch", default="pipeline_scratch", help="Scratch dir for intermediate CSVs and the top-K plot")
    ap.add_argument("--nested-cv", action="store_true",
                     help="Also run nested CV: re-do top-K selection AND hyperparameter tuning inside "
                          "each outer fold, for an honest (leakage-free) generalization estimate. "
                          "Expensive -- adds many extra XGBoost fits on top of the normal pipeline run.")
    ap.add_argument("--nested-cv-outer-folds", type=int, default=5, help="Nested CV: number of outer folds")
    ap.add_argument("--nested-cv-inner-folds", type=int, default=5,
                     help="Nested CV: number of inner folds used (per outer fold) for K-selection and hyperparameter tuning")
    ap.add_argument("--nested-cv-n-optuna", type=int, default=15,
                     help="Nested CV: number of Optuna trials used (per outer fold) for hyperparameter tuning")
    args = ap.parse_args()

    payload, bundle = run_pipeline(
        args.data, args.transient_data, args.scratch,
        nested_cv=args.nested_cv,
        nested_cv_outer_folds=args.nested_cv_outer_folds,
        nested_cv_inner_folds=args.nested_cv_inner_folds,
        nested_cv_n_optuna=args.nested_cv_n_optuna,
    )

    with open(args.out_model, "wb") as fh:
        pickle.dump(bundle, fh)
    print(f"\nWrote {args.out_model}")

    if args.out_json:
        with open(args.out_json, "w") as fh:
            json.dump(payload, fh)
        print(f"Wrote {args.out_json}")


if __name__ == "__main__":
    main()
