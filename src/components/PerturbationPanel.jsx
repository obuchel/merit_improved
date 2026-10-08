import React from 'react';
import { TRANSIENT_FORECAST } from '../transientForecast';
import InfoTip from './InfoTip';
import { PERTURBATION_META, PERTURBATION_CANDIDATES, computePerturbation, perturbationFactors } from '../perturbationTerms';

// Demand · displacement · perturbation, per night, with the formulas shown.
// Perturbation = a what-if shift applied on top of the modeled transient demand / ADR.
// Defaults are 0 (no change). Shifts are user what-ifs (Placeholder), not fitted coefficients.
const W = [0.3, 0.4, 0.3];
const card = { background: '#fff', border: '1px solid #e7e4da', borderRadius: 16, padding: '1.25rem 1.5rem', marginTop: '1rem' };
const th = { textAlign: 'right', padding: '4px 8px', fontWeight: 600, color: '#5b636b', whiteSpace: 'nowrap' };
const td = { textAlign: 'right', padding: '4px 8px', fontVariantNumeric: 'tabular-nums' };
const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const money = (v) => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString();
const disp = (D, block, cap) => Math.max(0, Math.min(block + D - cap, block, D));

export default function PerturbationPanel({ disp: d, block, delta, ps, rfp }) {
  const [dRooms, setDRooms] = React.useState(0);
  const [dAdr, setDAdr] = React.useState(0);
  const nights = d?.perNight || [];
  if (!nights.length) return null;
  const rows = nights.map(n => {
    const fc = TRANSIENT_FORECAST[n.date];
    const D = fc ? [fc[2], fc[0], fc[3]] : [n.transientDemand, n.transientDemand, n.transientDemand];
    const cap = n.capacity;
    const base = D.map(x => disp(x, block, cap));
    const pert = D.map(x => disp(Math.max(0, x + dRooms), block, cap));
    const e0 = base.reduce((s, v, i) => s + W[i] * v, 0);
    const e1 = pert.reduce((s, v, i) => s + W[i] * v, 0);
    const adr1 = (n.transientADR || 0) * (1 + dAdr / 100);
    return { n, D, base, e0, e1, c0: e0 * n.transientADR, c1: e1 * adr1, adr1 };
  });
  const cost0 = rows.reduce((s, r) => s + r.c0, 0);
  const cost1 = rows.reduce((s, r) => s + r.c1, 0);
  const fitted = computePerturbation(perturbationFactors(rfp, nights.length));
  const deltaStar = (Number(delta) || 0) + fitted.total - (cost1 - cost0);
  const inp = { width: 70, padding: '3px 6px', border: '1px solid #cfd6dd', borderRadius: 6 };
  return (
    <div style={card}>
      <div style={{ fontWeight: 700, fontSize: '1.0625rem', marginBottom: 6 }}>Demand · displacement · perturbation
        <InfoTip title="What this shows">Per night: forecast transient demand (low / median / high), how many of those rooms the block would push out, and what happens to the rooms value if demand or the transient rate turns out different from the forecast.</InfoTip>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8125rem' }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left' }}>Night</th><th style={th}>Capacity left</th>
            <th style={th}>Demand p10</th><th style={th}>p50</th><th style={th}>p90</th>
            <th style={th}>Displaced (exp.)</th><th style={th}>Transient ADR</th><th style={th}>Cost</th>
            <th style={th}>Displaced (what-if)</th><th style={th}>Cost (what-if)</th>
          </tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.n.date} style={{ borderTop: '1px solid #efece3' }}>
              <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{fmt(r.n.date)}</td>
              <td style={td}>{r.n.capacity}</td>
              <td style={td}>{Math.round(r.D[0])}</td><td style={td}>{Math.round(r.D[1])}</td><td style={td}>{Math.round(r.D[2])}</td>
              <td style={td}>{r.e0.toFixed(1)}</td><td style={td}>{money(r.n.transientADR)}</td><td style={td}>{money(r.c0)}</td>
              <td style={td}>{r.e1.toFixed(1)}</td><td style={td}>{money(r.c1)}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem', alignItems: 'center', marginTop: 12, fontSize: '0.875rem' }}>
        <label>Demand shift (rooms/night) <input type="number" style={inp} value={dRooms} onChange={e => setDRooms(Number(e.target.value) || 0)} /></label>
        <label>Transient ADR shift (%) <input type="number" style={inp} value={dAdr} onChange={e => setDAdr(Number(e.target.value) || 0)} /></label>
        <span style={{ color: '#5b636b' }}>Rooms value Δ {money(delta)} → <b style={{ color: '#1c2024' }}>Δ* {money(deltaStar)}</b></span>
      </div>
      <div style={{ marginTop: 14, padding: '0.75rem 1rem', background: '#f6f4ec', borderRadius: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem', lineHeight: 1.7, color: '#2b3138' }}>
        <div>capacity = total rooms − other groups booked</div>
        <div>displaced(D) = max(0, min(block + D − capacity, block, D))</div>
        <div>E[displaced] = 0.3·displaced(D<sub>p10</sub>) + 0.4·displaced(D<sub>p50</sub>) + 0.3·displaced(D<sub>p90</sub>)</div>
        <div>cost<sub>night</sub> = E[displaced] × transient ADR</div>
        <div>Δ = room revenue − Σ cost<sub>night</sub> − CPOR × occupied nights − concessions</div>
        <div>Perturbed: D′ = max(0, D + shift), ADR′ = ADR × (1 + shift%)</div>
        <div>Δ* = Δ + Σ<sub>k</sub> β<sub>k</sub> z<sub>k</sub> − (Σ cost′ − Σ cost), z<sub>k</sub> = (x<sub>k</sub> − mean<sub>k</sub>) / sd<sub>k</sub></div>
      </div>
      {(() => {
        const r = rows.find(x => x.e0 > 0.05) || rows[0];
        const n = r.n;
        const x = (v) => Math.round(v * 10) / 10;
        const dd = r.D.map((v, i) => x(r.base[i]));
        const rev = Number(ps?.roomRevenue) || 0, rc = Number(ps?.roomCost) || 0;
        const conc = rev - cost0 - rc - (Number(delta) || 0);
        return (
          <div style={{ marginTop: 10, padding: '0.75rem 1rem', background: '#eef3f8', borderRadius: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem', lineHeight: 1.7, color: '#1c2a38' }}>
            <div style={{ fontFamily: 'inherit', fontWeight: 700 }}>Worked example — {fmt(n.date)}</div>
            <div>capacity = {n.capacity + n.committed} − {n.committed} = {n.capacity}</div>
            <div>displaced(p10) = max(0, min({block} + {Math.round(r.D[0])} − {n.capacity}, {block}, {Math.round(r.D[0])})) = {dd[0]}</div>
            <div>displaced(p50) = max(0, min({block} + {Math.round(r.D[1])} − {n.capacity}, {block}, {Math.round(r.D[1])})) = {dd[1]}</div>
            <div>displaced(p90) = max(0, min({block} + {Math.round(r.D[2])} − {n.capacity}, {block}, {Math.round(r.D[2])})) = {dd[2]}</div>
            <div>E[displaced] = 0.3×{dd[0]} + 0.4×{dd[1]} + 0.3×{dd[2]} = {r.e0.toFixed(1)}</div>
            <div>cost = {r.e0.toFixed(1)} × {money(n.transientADR)} = {money(r.c0)}</div>
            <div style={{ marginTop: 6 }}>Δ = {money(rev)} (room revenue) − {money(cost0)} (displacement, all nights) − {money(rc)} (room cost) − {money(conc)} (concessions) = {money(delta)}</div>
            <div>Δ* = {money(delta)} + {money(fitted.total)} (fitted terms) − ({money(cost1)} − {money(cost0)}) = {money(deltaStar)}</div>
          </div>
        );
      })()}
      <div style={{ marginTop: 14, border: '1px solid #e7e4da', borderRadius: 10, padding: '0.75rem 1rem' }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Fitted perturbation terms <span style={{ fontWeight: 600, fontSize: '0.75rem', background: '#fef3c7', color: '#8a5a00', padding: '1px 7px', borderRadius: 5 }}>Simulated</span>
          <InfoTip title="How the terms were fitted">For each past won group: residual = realised value − the model's decision-time value. Realised value uses actual pickup and the actual transient demand and rate; decision-time value uses expected pickup and a forecast made without that year's data. Ridge regression on quote-time factors, tested on 2025 after fitting 2023–24, and by leaving out each year in turn. A term is kept only if held-out error shrinks in every fold.</InfoTip></div>
        <div style={{ fontSize: '0.8125rem', color: '#44505c', marginBottom: 8 }}>
          {fitted.lines.length
            ? fitted.lines.map(l => <div key={l.factor}>{l.label} {l.value < 0 ? '−' : '+'}${Math.abs(Math.round(l.value)).toLocaleString()}</div>)
            : <>No term passed the held-out check, so Δ* = Δ (fitted terms add $0). On {PERTURBATION_META.n.toLocaleString()} simulated won groups the mean residual was {money(PERTURBATION_META.meanResidual)} (sd {money(PERTURBATION_META.sdResidual)}); on 2025 the ridge terms gave a held-out error of {money(PERTURBATION_META.heldOut.mae_ridge)} against {money(PERTURBATION_META.heldOut.mae_bias_only)} for no terms.</>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.78rem' }}>
            <thead><tr><th style={{ ...th, textAlign: 'left' }}>Candidate factor</th><th style={th}>From model</th><th style={th}>β per SD ($)</th><th style={th}>R² vs base inputs</th><th style={th}>β alone → controlled</th><th style={th}>Verdict</th></tr></thead>
            <tbody>{PERTURBATION_CANDIDATES.map(c => (
              <tr key={c.factor} style={{ borderTop: '1px solid #efece3' }}>
                <td style={{ ...td, textAlign: 'left' }}>{c.label}</td>
                <td style={td}>{(c.sources || []).filter(s => s !== 'manual').join(', ') || 'added by hand'}</td>
                <td style={td}>{c.betaPerSd == null ? '—' : (c.betaPerSd > 0 ? '+' : '') + Math.round(c.betaPerSd)}</td>
                <td style={td}>{c.r2Base == null ? '—' : c.r2Base.toFixed(2)}</td>
                <td style={td}>{c.betaAlone == null ? '—' : Math.round(c.betaAlone) + ' → ' + Math.round(c.betaControlled)}</td>
                <td style={{ ...td, color: c.status === 'accepted' ? '#166534' : '#9b1c1c' }}>{c.status === 'excluded: leak' ? 'leak: ' + c.reason : c.status === 'redundant' ? 'redundant: already in Δ' : c.status === 'absorbed' ? 'absorbed by base inputs' : c.status}</td>
              </tr>))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 6 }}>
          {PERTURBATION_META.nCandidates} candidates from the model importances: {PERTURBATION_META.nLeak} excluded as outcome leaks, {PERTURBATION_META.nRedundant} redundant (nearly a copy of inputs Δ already uses, R² ≥ 0.8), {PERTURBATION_META.nAbsorbed} absorbed (their effect vanishes or flips once those inputs are held fixed), {PERTURBATION_META.nFitted - PERTURBATION_META.nDoubleCount} independent. Held-out check: no combination improves the 2025 error in all three year-folds, so no term is applied and Δ* = Δ.
        </div>
      </div>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 8 }}>
        Demand p10/p50/p90: modeled from 2023–25 history (Simulated forecast; MAE ≈ 14 rooms). Shifts are what-if inputs (Placeholder), default 0. Terms are applied only if accepted in the table above; today none is, so the app's value is Δ* = Δ.
      </div>
    </div>
  );
}
