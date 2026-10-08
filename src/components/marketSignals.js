/**
 * marketSignals.js
 *
 * Derives real-time market signals from existing Firestore data
 * (booked_events, rfps, incoming_rfps) and writes them to
 * market_signals/latest.  These values replace the hardcoded
 * placeholders in the XGBoost feature dict.
 *
 * Signals produced
 * ────────────────
 * avg_discount_nearby_30d      $$  off rack rate for recent bookings
 * occupancy_velocity_30_90d    fractional Δ in avg occ between windows
 * rfp_volume_acceleration      fractional Δ in new RFP count  30d vs 31-60d
 * booking_pace_7_30d           ratio: 7-day daily pace / 30-day daily pace
 * revenue_velocity_30_90d      fractional Δ in daily room revenue
 * revenue_acceleration         second derivative (30 vs 31-60 vs 61-90)
 * displacement_velocity_30_90d fractional Δ in displacement cost
 * displacement_acceleration    second derivative of displacement cost
 * win_rate_velocity_30_90d     Δ in win rate between windows
 * smerf_demand_30d             count of SMERF-type RFPs in last 30 days
 */

import { db } from './firebase';
import {
  collection, getDocs, getDoc, doc, setDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASELINE_ADR = 164;
const SMERF_SEGMENTS = ['smerf', 'social', 'military', 'education', 'religious', 'fraternal', 'government', 'association'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const daysAgo = n => new Date(Date.now() - n * 86_400_000);

/** Accept Firestore Timestamp, JS Date, or ISO string. */
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

/** Fractional velocity between two daily-rate averages (returns 0 when no baseline). */
function velocity(recent, recentDays, older, olderDays) {
  const dailyRecent = recent / recentDays;
  const dailyOlder  = older  / olderDays;
  return dailyOlder > 0 ? (dailyRecent - dailyOlder) / dailyOlder : 0;
}

/** Filter items whose reference date falls in [from, to). */
function inWindow(items, getDate, from, to = null) {
  return items.filter(item => {
    const d = getDate(item);
    if (!d) return false;
    if (d < from) return false;
    if (to && d >= to) return false;
    return true;
  });
}

/** Room-nights for one event record. */
function roomNights(e) {
  const rooms  = Number(e.Peak_Room_Block || e.room_block || 0);
  const nights = Math.max(1, Number(e.nights || e.Nights || 1));
  return rooms * nights;
}

/** Quoted ADR for one event record (falls back to standard group rate). */
function quotedADROf(e) {
  return Number(e.quoted_adr || e.Quoted_ADR || e.baseADR || BASELINE_ADR * 0.88);
}

/** Forecasted occupancy normalised to 0-1. */
function occOf(e) {
  const raw = Number(e.forecasted_occupancy || e.Forecasted_Occupancy || 0.72);
  return raw > 1 ? raw / 100 : raw;
}

// ─── Core computation ─────────────────────────────────────────────────────────

export async function computeMarketSignals() {
  const [bookedSnap, rfpSnap, incomingSnap] = await Promise.all([
    getDocs(collection(db, 'booked_events')),
    getDocs(collection(db, 'rfps')),
    getDocs(collection(db, 'incoming_rfps')),
  ]);

  const booked   = bookedSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const rfps     = rfpSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const incoming = incomingSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const allRfps  = [...rfps, ...incoming];

  // Date windows
  const now  = new Date();
  const c7   = daysAgo(7);
  const c30  = daysAgo(30);
  const c60  = daysAgo(60);
  const c90  = daysAgo(90);

  // Reference date for bookings = created_at, fall back to arrival_date
  const bookedDate  = e => toDate(e.created_at)  || toDate(e.Arrival_Date || e.arrival_date);
  // Reference date for RFPs    = created_at, fall back to inquiry_date
  const rfpDate     = r => toDate(r.created_at)  || toDate(r.Inquiry_Date || r.inquiry_date);

  // ── Booked-event windows ──────────────────────────────────────────────────

  const b7     = inWindow(booked, bookedDate, c7);
  const b30    = inWindow(booked, bookedDate, c30);
  const b31_60 = inWindow(booked, bookedDate, c60, c30);
  const b61_90 = inWindow(booked, bookedDate, c90, c60);

  // ─ avg_discount_nearby_30d ($$ off rack) ─────────────────────────────────
  const discounts = b30
    .map(e => { const q = quotedADROf(e); return q > 0 ? Math.max(0, BASELINE_ADR - q) : null; })
    .filter(v => v !== null);
  const avg_discount_nearby_30d = discounts.length ? mean(discounts) : 12;

  // ─ booking_pace_7_30d (7-day daily pace / 30-day daily pace) ─────────────
  const rn7  = b7.reduce((s, e)  => s + roomNights(e), 0);
  const rn30 = b30.reduce((s, e) => s + roomNights(e), 0);
  const booking_pace_7_30d = rn30 > 0 ? (rn7 / 7) / (rn30 / 30) : 1.0;

  // ─ revenue_velocity and revenue_acceleration ──────────────────────────────
  const revOf    = list => list.reduce((s, e) => s + quotedADROf(e) * roomNights(e), 0);
  const rev30    = revOf(b30);
  const rev31_60 = revOf(b31_60);
  const rev61_90 = revOf(b61_90);
  const revenue_velocity_30_90d   = velocity(rev30, 30, rev31_60, 30);
  // True acceleration: how velocity itself is changing
  const vel31_60 = velocity(rev31_60, 30, rev61_90, 30);
  const revenue_acceleration      = revenue_velocity_30_90d - vel31_60;

  // ─ occupancy_velocity_30_90d ─────────────────────────────────────────────
  const occs30    = b30.map(occOf);
  const occs31_60 = b31_60.map(occOf);
  const avgOcc30    = mean(occs30)    ?? 0.72;
  const avgOcc31_60 = mean(occs31_60) ?? 0.72;
  const occupancy_velocity_30_90d = avgOcc31_60 > 0
    ? (avgOcc30 - avgOcc31_60) / avgOcc31_60
    : 0;

  // ─ displacement_velocity and acceleration ─────────────────────────────────
  const dispOf = list =>
    list.reduce((s, e) => s + BASELINE_ADR * roomNights(e) * 0.28 * occOf(e), 0);
  const disp30    = dispOf(b30);
  const disp31_60 = dispOf(b31_60);
  const disp61_90 = dispOf(b61_90);
  const displacement_velocity_30_90d = velocity(disp30, 30, disp31_60, 30);
  const dispVel31_60                 = velocity(disp31_60, 30, disp61_90, 30);
  const displacement_acceleration    = displacement_velocity_30_90d - dispVel31_60;

  // ── RFP windows ──────────────────────────────────────────────────────────

  const rfp30    = inWindow(allRfps, rfpDate, c30);
  const rfp31_60 = inWindow(allRfps, rfpDate, c60, c30);
  const rfp31_90 = inWindow(allRfps, rfpDate, c90, c30);

  // ─ rfp_volume_acceleration ───────────────────────────────────────────────
  const rfp_volume_acceleration = rfp31_60.length > 0
    ? (rfp30.length - rfp31_60.length) / rfp31_60.length
    : 0;

  // ─ win_rate_velocity_30_90d ──────────────────────────────────────────────
  const isWon   = r => ['approved', 'won', 'accepted'].includes((r.status || r.Status || '').toLowerCase());
  const winRate = list => list.length > 0 ? list.filter(isWon).length / list.length : 0.5;
  const win_rate_velocity_30_90d = winRate(rfp30) - winRate(rfp31_90);

  // ─ smerf_demand_30d ──────────────────────────────────────────────────────
  const smerf_demand_30d = rfp30.filter(r => {
    const seg = (r.market_segment || r.Market_Segment || '').toLowerCase();
    return SMERF_SEGMENTS.some(s => seg.includes(s));
  }).length;

  // ─ Competing RFPs same week (used in the feature dict) ───────────────────
  // Count unique arrival weeks that appear more than once in the 30-day RFP window
  const weekCounts = {};
  rfp30.forEach(r => {
    const d = toDate(r.Arrival_Date || r.arrival_date);
    if (!d) return;
    const week = `${d.getFullYear()}-W${Math.ceil((d - new Date(d.getFullYear(), 0, 1)) / 604_800_000)}`;
    weekCounts[week] = (weekCounts[week] || 0) + 1;
  });
  const competing_rfps_same_week_segment = rfp30.length > 0
    ? Object.values(weekCounts).reduce((s, v) => s + Math.max(0, v - 1), 0) / rfp30.length * 10
    : 4;

  const signals = {
    // Pricing
    avg_discount_nearby_30d:       Math.round(avg_discount_nearby_30d * 100) / 100,
    // Demand
    occupancy_velocity_30_90d:     Math.round(occupancy_velocity_30_90d * 10000) / 10000,
    rfp_volume_acceleration:       Math.round(rfp_volume_acceleration * 10000) / 10000,
    booking_pace_7_30d:            Math.round(booking_pace_7_30d * 10000) / 10000,
    // Revenue
    revenue_velocity_30_90d:       Math.round(revenue_velocity_30_90d * 10000) / 10000,
    revenue_acceleration:          Math.round(revenue_acceleration * 10000) / 10000,
    // Displacement
    displacement_velocity_30_90d:  Math.round(displacement_velocity_30_90d * 10000) / 10000,
    displacement_acceleration:     Math.round(displacement_acceleration * 10000) / 10000,
    // Pipeline
    win_rate_velocity_30_90d:      Math.round(win_rate_velocity_30_90d * 10000) / 10000,
    smerf_demand_30d:              smerf_demand_30d,
    competing_rfps_same_week_segment: Math.round(competing_rfps_same_week_segment * 10) / 10,
    // Meta
    computed_at: serverTimestamp(),
    source_counts: {
      booked_total:  booked.length,
      booked_30d:    b30.length,
      rfp_total:     allRfps.length,
      rfp_30d:       rfp30.length,
    },
  };

  await setDoc(doc(db, 'market_signals', 'latest'), signals);
  console.log('[marketSignals] Computed and saved:', signals);
  return signals;
}

// ─── Hotel config (Firestore: hotel_config/settings) ─────────────────────────
//
// These were previously hardcoded in scoreRFP. They now live in Firestore so
// they can be updated without touching source code.

export const CONFIG_DEFAULTS = {
  baseline_adr:                 164,   // rack rate $$
  group_discount_pct:           0.12,  // fraction off rack for group quoted ADR
  meeting_rate_per_room_night:  18,    // $$/room/night for space + AV package
  displacement_factor:          0.28,  // share of transient ADR treated as displacement cost
  total_rooms:                  220,   // hotel capacity
};

/**
 * Writes CONFIG_DEFAULTS to hotel_config/settings only if the document
 * does not already exist.  Call once on first login.
 */
export async function initHotelConfig() {
  const ref = doc(db, 'hotel_config', 'settings');
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { ...CONFIG_DEFAULTS, created_at: serverTimestamp() });
    console.log('[hotelConfig] Initialized with defaults');
  }
}

/**
 * useHotelConfig()
 * Subscribes to hotel_config/settings.  Returns { config, loading }.
 */
export function useHotelConfig() {
  const [config,  setConfig]  = React.useState(CONFIG_DEFAULTS);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const unsub = onSnapshot(doc(db, 'hotel_config', 'settings'), snap => {
      if (snap.exists()) setConfig({ ...CONFIG_DEFAULTS, ...snap.data() });
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return { config, loading };
}

// ─── Fallback defaults (mirrors old hardcoded values) ─────────────────────────

export const SIGNAL_DEFAULTS = {
  avg_discount_nearby_30d:        12,
  occupancy_velocity_30_90d:       0,
  rfp_volume_acceleration:         0,
  booking_pace_7_30d:              1.0,
  revenue_velocity_30_90d:         0,
  revenue_acceleration:            0,
  displacement_velocity_30_90d:    0,
  displacement_acceleration:       0,
  win_rate_velocity_30_90d:        0,
  smerf_demand_30d:                3,
  competing_rfps_same_week_segment: 4,
};

// ─── React hook ───────────────────────────────────────────────────────────────

/**
 * useMarketSignals()
 *
 * Subscribes to market_signals/latest in Firestore.
 * Returns { signals, loading, age } where age is minutes since last compute.
 */
export function useMarketSignals() {
  const [signals, setSignals] = React.useState(SIGNAL_DEFAULTS);
  const [loading, setLoading] = React.useState(true);
  const [age,     setAge]     = React.useState(null);

  React.useEffect(() => {
    const unsub = onSnapshot(doc(db, 'market_signals', 'latest'), snap => {
      if (snap.exists()) {
        const data = snap.data();
        setSignals({ ...SIGNAL_DEFAULTS, ...data });
        const computedAt = data.computed_at?.toDate?.();
        setAge(computedAt ? Math.round((Date.now() - computedAt) / 60000) : null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  return { signals, loading, age };
}

// React must be importable in this file when used as a hook
import React from 'react';
