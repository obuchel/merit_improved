import { useState, useEffect, useRef, useCallback } from "react";

// ─── NEGOTIATION ENGINE ──────────────────────────────────────────────────────

const ISSUES = [
  { key: "adr", label: "ADR (€)", min: 140, max: 320, step: 5, type: "continuous", unit: "€" },
  { key: "fnb_credit", label: "F&B Credit/person", min: 0, max: 60, step: 5, type: "continuous", unit: "€" },
  { key: "space_discount", label: "Space Discount", min: 0, max: 70, step: 5, type: "continuous", unit: "%" },
  { key: "comp_rooms", label: "Comp Rooms", min: 0, max: 6, step: 1, type: "continuous", unit: "" },
  { key: "wifi", label: "Free WiFi", values: [0, 1], type: "binary" },
  { key: "late_checkout", label: "Late Checkout", values: [0, 1], type: "binary" },
  { key: "welcome_reception", label: "Welcome Reception", values: [0, 1], type: "binary" },
  { key: "av_package", label: "AV Package", values: [0, 1], type: "binary" },
];

function norm(issue, val) { return issue.type === "binary" ? val : (val - issue.min) / (issue.max - issue.min); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hotelUtility(a, w) {
  let u = 0;
  ISSUES.forEach(is => { u += (w[is.key] || 0) * norm(is, a[is.key]); });
  u += 0.06 * norm(ISSUES[0], a.adr) * (1 - norm(ISSUES[1], a.fnb_credit));
  u -= 0.04 * norm(ISSUES[2], a.space_discount) * a.welcome_reception;
  u -= 0.03 * norm(ISSUES[3], a.comp_rooms) * a.late_checkout;
  return u;
}

function clientUtility(a, w) {
  let u = 0;
  ISSUES.forEach(is => { u += (w[is.key] || 0) * norm(is, a[is.key]); });
  u += 0.05 * norm(ISSUES[1], a.fnb_credit) * a.welcome_reception;
  u += 0.04 * (1 - norm(ISSUES[0], a.adr)) * a.av_package;
  u += 0.03 * norm(ISSUES[2], a.space_discount) * a.av_package;
  return u;
}

function randomAgreement() {
  const a = {};
  ISSUES.forEach(is => {
    if (is.type === "binary") a[is.key] = Math.random() > 0.5 ? 1 : 0;
    else { const steps = Math.round((is.max - is.min) / is.step); a[is.key] = is.min + Math.floor(Math.random() * (steps + 1)) * is.step; }
  });
  return a;
}

function mutate(a) {
  const out = { ...a };
  const is = ISSUES[Math.floor(Math.random() * ISSUES.length)];
  if (is.type === "binary") out[is.key] = out[is.key] === 1 ? 0 : 1;
  else { const d = (Math.random() > 0.5 ? 1 : -1) * is.step * Math.ceil(Math.random() * 3); out[is.key] = clamp(out[is.key] + d, is.min, is.max); }
  return out;
}

function smartMutate(a, fn) {
  let best = null, bestU = -Infinity;
  for (let i = 0; i < 5; i++) { const c = mutate(a); const u = fn(c); if (u > bestU) { bestU = u; best = c; } }
  return best || mutate(a);
}

function vote(cur, last) { const d = cur - last; return d > 0.02 ? 1 : d > -0.005 ? 0 : d > -0.03 ? -1 : -2; }

function runNegotiation(hw, cw, cfg) {
  const { maxRounds = 300, initialTemp = 2.0, coolingRate = 0.985, initialTokens = 4 } = cfg;
  let cur = randomAgreement(), best = { ...cur }, bestSW = -Infinity, T = initialTemp, hTok = initialTokens, cTok = initialTokens;
  const hU = a => hotelUtility(a, hw), cU = a => clientUtility(a, cw);
  let lhU = hU(cur), lcU = cU(cur), hOver = 0, cOver = 0;
  const hist = [{ round: 0, agreement: { ...cur }, hotelUtility: lhU, clientUtility: lcU, socialWelfare: lhU + lcU, accepted: true, temperature: T, hotelVote: 1, clientVote: 1, hotelTokens: hTok, clientTokens: cTok, event: "initial", proposer: null }];

  for (let r = 1; r <= maxRounds; r++) {
    const isH = r % 2 === 0, prop = smartMutate(cur, isH ? hU : cU);
    const ph = hU(prop), pc = cU(prop), sw = ph + pc, hv = vote(ph, lhU), cv = vote(pc, lcU), agg = hv + cv;
    let acc = false, evt = "rejected";
    if (agg >= 0) {
      acc = true; evt = agg >= 2 ? "mutual_accept" : "weak_override";
      if (hv < 0 && cv > 0) { if (cTok > 0 && cOver - hOver < 3) { cTok--; hTok++; cOver++; evt = "client_override"; } else { acc = false; evt = "blocked"; } }
      else if (cv < 0 && hv > 0) { if (hTok > 0 && hOver - cOver < 3) { hTok--; cTok++; hOver++; evt = "hotel_override"; } else { acc = false; evt = "blocked"; } }
    } else { if (Math.random() < Math.min(1, Math.exp(agg / T)) * 0.3) { acc = true; evt = "annealing"; } }
    if (acc) { cur = { ...prop }; lhU = ph; lcU = pc; if (sw > bestSW) { bestSW = sw; best = { ...prop }; } }
    T *= coolingRate;
    hist.push({ round: r, agreement: acc ? { ...prop } : { ...cur }, hotelUtility: acc ? ph : lhU, clientUtility: acc ? pc : lcU, socialWelfare: acc ? sw : lhU + lcU, accepted: acc, temperature: T, hotelVote: hv, clientVote: cv, hotelTokens: hTok, clientTokens: cTok, event: evt, proposer: isH ? "hotel" : "client" });
  }
  return { history: hist, bestAgreement: best, bestSocialWelfare: bestSW };
}

function estimatePareto(hw, cw) {
  const pts = [];
  for (let i = 0; i < 300; i++) { const a = randomAgreement(); pts.push({ h: hotelUtility(a, hw), c: clientUtility(a, cw) }); }
  for (let alpha = 0; alpha <= 1; alpha += 0.05) {
    let b = randomAgreement(), bs = alpha * hotelUtility(b, hw) + (1 - alpha) * clientUtility(b, cw);
    for (let j = 0; j < 150; j++) { const c = mutate(b); const s = alpha * hotelUtility(c, hw) + (1 - alpha) * clientUtility(c, cw); if (s > bs) { b = c; bs = s; } }
    pts.push({ h: hotelUtility(b, hw), c: clientUtility(b, cw) });
  }
  pts.sort((a, b) => a.h - b.h);
  const f = []; let mx = -Infinity;
  for (let i = pts.length - 1; i >= 0; i--) { if (pts[i].c > mx) { mx = pts[i].c; f.push(pts[i]); } }
  f.sort((a, b) => a.h - b.h);
  return f;
}

// ─── SVG CHART ───────────────────────────────────────────────────────────────

function ParetoChart({ history, pareto, w = 460, h = 300 }) {
  if (!history?.length) return null;
  const m = { t: 20, r: 16, b: 40, l: 48 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const allH = history.map(d => d.hotelUtility).concat(pareto.map(d => d.h));
  const allC = history.map(d => d.clientUtility).concat(pareto.map(d => d.c));
  const xMin = Math.min(...allH) - 0.02, xMax = Math.max(...allH) + 0.02;
  const yMin = Math.min(...allC) - 0.02, yMax = Math.max(...allC) + 0.02;
  const sx = v => m.l + ((v - xMin) / (xMax - xMin)) * iw;
  const sy = v => m.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const acc = history.filter(d => d.accepted), rej = history.filter(d => !d.accepted);
  const aPath = acc.map((d, i) => `${i === 0 ? "M" : "L"}${sx(d.hotelUtility)},${sy(d.clientUtility)}`).join(" ");
  const pPath = pareto.length > 1 ? pareto.map((d, i) => `${i === 0 ? "M" : "L"}${sx(d.h)},${sy(d.c)}`).join(" ") : "";
  const last = acc[acc.length - 1], first = acc[0];

  return (
    <svg width={w} height={h} style={{ background: "#0c1322", borderRadius: 10 }}>
      {[0.25, 0.5, 0.75].map(f => <React.Fragment key={f}><line x1={m.l} y1={m.t + ih * f} x2={m.l + iw} y2={m.t + ih * f} stroke="#1a2640" strokeWidth={0.5} /><line x1={m.l + iw * f} y1={m.t} x2={m.l + iw * f} y2={m.t + ih} stroke="#1a2640" strokeWidth={0.5} /></React.Fragment>)}
      <line x1={m.l} y1={m.t + ih} x2={m.l + iw} y2={m.t + ih} stroke="#253050" />
      <line x1={m.l} y1={m.t} x2={m.l} y2={m.t + ih} stroke="#253050" />
      <text x={m.l + iw / 2} y={h - 5} textAnchor="middle" fill="#3b82f6" fontSize={10} fontWeight={600}>Hotel Utility →</text>
      <text transform="rotate(-90)" x={-(m.t + ih / 2)} y={12} textAnchor="middle" fill="#10b981" fontSize={10} fontWeight={600}>Client Utility →</text>
      {pPath && <path d={pPath} fill="none" stroke="#f43f5e" strokeWidth={2} strokeDasharray="5,3" opacity={0.55} />}
      {rej.map((d, i) => <circle key={i} cx={sx(d.hotelUtility)} cy={sy(d.clientUtility)} r={1} fill="#475569" opacity={0.12} />)}
      {aPath && <path d={aPath} fill="none" stroke="#f59e0b" strokeWidth={1.5} opacity={0.35} />}
      {acc.map((d, i) => <circle key={i} cx={sx(d.hotelUtility)} cy={sy(d.clientUtility)} r={i === acc.length - 1 ? 5 : i === 0 ? 4 : 1.8} fill={i === acc.length - 1 ? "#f59e0b" : i === 0 ? "#64748b" : "#f59e0b"} opacity={i === acc.length - 1 ? 1 : 0.45} stroke={i === acc.length - 1 ? "#fff" : "none"} strokeWidth={2} />)}
      {first && <text x={sx(first.hotelUtility) + 7} y={sy(first.clientUtility) + 3} fill="#64748b" fontSize={8} fontFamily="monospace">START</text>}
      {last && <text x={sx(last.hotelUtility) + 8} y={sy(last.clientUtility) + 3} fill="#f59e0b" fontSize={9} fontWeight={700} fontFamily="monospace">FINAL</text>}
      <line x1={w - 100} y1={13} x2={w - 86} y2={13} stroke="#f43f5e" strokeWidth={2} strokeDasharray="3,2" />
      <text x={w - 82} y={16} fill="#f43f5e" fontSize={7}>Pareto</text>
      <circle cx={w - 93} cy={26} r={3} fill="#f59e0b" />
      <text x={w - 82} y={29} fill="#f59e0b" fontSize={7}>Accepted</text>
    </svg>
  );
}

// ─── STRATEGY CARDS (matching existing app) ──────────────────────────────────

const sampleRFP = { event_name: "European Tech Summit 2026", attendees: 200, room_block: 120, arrival_date: "2026-06-15", departure_date: "2026-06-18", client_priority: "High" };

function buildFallbackStrategies(rfp) {
  const nights = 3;
  const base = 220 * rfp.room_block * nights * 0.79;
  const fnb = rfp.attendees * 60;
  const sp = 8000;
  return [
    { name: "Conservative Capture", risk: "Low Risk", adr: 209, pickupRate: 84, conversionProb: 80, gviIndex: 225, roomRevenue: Math.round(base * 0.95), fnbRevenue: Math.round(fnb * 0.9), spaceRevenue: Math.round(sp), totalRevenue: Math.round(base * 0.95 + fnb * 0.9 + sp), expectedProfit: Math.round((base * 0.95 + fnb * 0.9 + sp) * 0.44), riskAdjustedValue: Math.round((base * 0.95 + fnb * 0.9 + sp) * 0.44 * 0.80), roiVsBaseline: "+71%", color: "success", includes: ["2 comp rooms", "€30/person F&B credit", "50% space discount", "Free WiFi", "Late checkout", "Welcome reception"], subtitle: "Conservative alternative" },
    { name: "Optimal Balance", risk: "Medium Risk", adr: 220, pickupRate: 79, conversionProb: 70, gviIndex: 261, roomRevenue: Math.round(base), fnbRevenue: Math.round(fnb), spaceRevenue: Math.round(sp * 1.4), totalRevenue: Math.round(base + fnb + sp * 1.4), expectedProfit: Math.round((base + fnb + sp * 1.4) * 0.44), riskAdjustedValue: Math.round((base + fnb + sp * 1.4) * 0.44 * 0.70), roiVsBaseline: "+103%", color: "warning", recommended: true, includes: ["2 comp rooms", "€25/person F&B credit", "30% space discount", "Free WiFi", "Late checkout"], subtitle: "Recommended Strategy" },
    { name: "Premium Position", risk: "Higher Risk", adr: 253, pickupRate: 75, conversionProb: 55, gviIndex: 289, roomRevenue: Math.round(base * 1.05), fnbRevenue: Math.round(fnb * 1.2), spaceRevenue: Math.round(sp * 1.7), totalRevenue: Math.round(base * 1.05 + fnb * 1.2 + sp * 1.7), expectedProfit: Math.round((base * 1.05 + fnb * 1.2 + sp * 1.7) * 0.43), riskAdjustedValue: Math.round((base * 1.05 + fnb * 1.2 + sp * 1.7) * 0.43 * 0.55), roiVsBaseline: "+128%", color: "error", includes: ["2 comp rooms", "€20/person F&B credit", "15% space discount", "Free WiFi"], subtitle: "Higher profit, higher risk" },
  ];
}

function agreementToStrategy(a, rfp, hw, cw) {
  const nights = 3, pick = 0.79;
  const rr = Math.round(a.adr * rfp.room_block * nights * pick);
  const fr = Math.round(rfp.attendees * a.fnb_credit * nights);
  const sr = Math.round(8000 * (1 - a.space_discount / 100));
  const total = rr + fr + sr;
  const hU = hotelUtility(a, hw), cU = clientUtility(a, cw);
  const inc = [];
  if (a.comp_rooms > 0) inc.push(`${a.comp_rooms} comp rooms`);
  if (a.fnb_credit > 0) inc.push(`€${a.fnb_credit}/person F&B credit`);
  if (a.space_discount > 0) inc.push(`${a.space_discount}% space discount`);
  if (a.wifi) inc.push("Free WiFi");
  if (a.late_checkout) inc.push("Late checkout");
  if (a.welcome_reception) inc.push("Welcome reception");
  if (a.av_package) inc.push("AV package included");
  return { name: "Negotiated Optimum", risk: "Balanced", adr: a.adr, pickupRate: Math.round(pick * 100), conversionProb: Math.round(Math.min(85, 50 + cU * 100)), gviIndex: Math.round(total / (rfp.room_block * nights)), roomRevenue: rr, fnbRevenue: fr, spaceRevenue: sr, totalRevenue: total, expectedProfit: Math.round(total * 0.44), riskAdjustedValue: Math.round(total * 0.44 * Math.min(0.85, 0.5 + cU)), roiVsBaseline: "+" + Math.round((total / (220 * rfp.room_block * nights * 0.79) - 1) * 100) + "%", color: "negotiated", negotiated: true, hotelU: hU, clientU: cU, includes: inc, subtitle: "Apply Negotiated Deal", agreement: { ...a } };
}

// ─── COLORS & STYLES ─────────────────────────────────────────────────────────

const C = {
  bg: "#f8fafc", surface: "#ffffff", dark: "#0c1322", darkSurface: "#111b2e", border: "#e2e8f0", borderDark: "#1e2d4a",
  primary: "#5b5fc7", hotel: "#3b82f6", client: "#10b981", accent: "#f59e0b", pareto: "#f43f5e", anneal: "#a855f7",
  text: "#1e293b", textMuted: "#64748b", textDim: "#94a3b8",
  success: { bg: "#d1fae5", text: "#065f46" }, warning: { bg: "#fef3c7", text: "#92400e" }, error: { bg: "#fee2e2", text: "#991b1b" },
};

const riskColors = { success: C.success, warning: C.warning, error: C.error, negotiated: C.warning };

// ─── MAIN APP ────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState("strategies"); // strategies | negotiate
  const [strategies] = useState(buildFallbackStrategies(sampleRFP));
  const [negStrategy, setNegStrategy] = useState(null);
  const [negPhase, setNegPhase] = useState("config"); // config | running | results
  const [result, setResult] = useState(null);
  const [pareto, setPareto] = useState([]);
  const [animIdx, setAnimIdx] = useState(0);
  const [speed, setSpeed] = useState(8);
  const animRef = useRef(null);
  const [hw, setHw] = useState({ adr: 0.35, fnb_credit: -0.15, space_discount: -0.12, comp_rooms: -0.10, wifi: -0.04, late_checkout: -0.03, welcome_reception: -0.08, av_package: -0.06 });
  const cw = { adr: -0.30, fnb_credit: 0.18, space_discount: 0.14, comp_rooms: 0.10, wifi: 0.06, late_checkout: 0.04, welcome_reception: 0.07, av_package: 0.05 };
  const [cfg, setCfg] = useState({ maxRounds: 300, initialTemp: 2.0, coolingRate: 0.985, initialTokens: 4 });

  const runNeg = useCallback(() => {
    setNegPhase("running"); setAnimIdx(0);
    const p = estimatePareto(hw, cw); setPareto(p);
    const r = runNegotiation(hw, cw, cfg); setResult(r);
  }, [hw, cw, cfg]);

  useEffect(() => {
    if (negPhase !== "running" || !result) return;
    if (animIdx >= result.history.length) { setNegPhase("results"); return; }
    animRef.current = setTimeout(() => setAnimIdx(i => i + speed), 16);
    return () => clearTimeout(animRef.current);
  }, [negPhase, animIdx, result, speed]);

  const vis = result ? result.history.slice(0, Math.min(animIdx, result.history.length)) : [];
  const latest = vis.length > 0 ? vis[vis.length - 1] : null;
  const final = result?.bestAgreement;
  const accN = vis.filter(d => d.accepted).length;
  const annN = vis.filter(d => d.event === "annealing").length;
  const ovrN = vis.filter(d => d.event?.includes("override")).length;

  const applyNeg = () => { if (!final) return; setNegStrategy(agreementToStrategy(final, sampleRFP, hw, cw)); setTab("strategies"); };
  const allStrats = [...strategies, ...(negStrategy ? [negStrategy] : [])];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", color: C.text }}>
      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "14px 28px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${C.primary}, ${C.hotel})`, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 15 }}>R</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>RFP Revenue Manager</div>
            <div style={{ fontSize: 11, color: C.textDim }}>Strategy & Negotiation Engine</div>
          </div>
        </div>
        {/* Tabs */}
        <div style={{ display: "flex", gap: 3, background: "#f1f5f9", padding: 3, borderRadius: 10 }}>
          {[{ k: "strategies", icon: "📊", label: "Strategies" }, { k: "negotiate", icon: "⚡", label: "Negotiate" }].map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 18px", background: tab === t.k ? "#fff" : "transparent", border: "none", borderRadius: 8, fontSize: 13, fontWeight: tab === t.k ? 600 : 400, color: tab === t.k ? C.text : C.textMuted, cursor: "pointer", boxShadow: tab === t.k ? "0 1px 3px rgba(0,0,0,.08)" : "none", transition: "all .15s" }}>
              {t.icon} {t.label}
              {t.k === "strategies" && negStrategy && <span style={{ background: C.accent, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, marginLeft: 2 }}>+1</span>}
            </button>
          ))}
        </div>
      </div>

      {/* RFP Bar */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 28px 0" }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 20px", display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
          <div><div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1 }}>Event</div><div style={{ fontSize: 15, fontWeight: 700 }}>{sampleRFP.event_name}</div></div>
          {[{ l: "Attendees", v: sampleRFP.attendees }, { l: "Rooms", v: sampleRFP.room_block }, { l: "Nights", v: 3 }, { l: "Priority", v: sampleRFP.client_priority }].map(d => (
            <div key={d.l}><div style={{ fontSize: 10, color: C.textDim }}>{d.l}</div><div style={{ fontSize: 15, fontWeight: 700 }}>{d.v}</div></div>
          ))}
        </div>

        {/* ─── STRATEGIES TAB ────────────────────────────────────────────── */}
        {tab === "strategies" && (
          <div>
            <h3 style={{ textAlign: "center", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Recommended Pricing Strategies</h3>
            <p style={{ textAlign: "center", color: C.textMuted, marginBottom: 24, fontSize: 14 }}>
              {negStrategy ? <>The <span style={{ color: C.accent, fontWeight: 600 }}>negotiated strategy</span> was generated via the annealing mediator protocol.</> : <>The <span style={{ color: C.primary, fontWeight: 600 }}>highlighted option</span> is recommended based on market conditions.</>}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${allStrats.length}, 1fr)`, gap: 18 }}>
              {allStrats.map((s, i) => {
                const rc = riskColors[s.color] || C.warning;
                const isBest = s.recommended;
                const isNeg = s.negotiated;
                return (
                  <div key={i} style={{ background: isNeg ? "linear-gradient(180deg, #fffbeb 0%, #fff 8%)" : "#fff", border: `${isBest || isNeg ? 3 : 2}px solid ${isBest ? C.primary : isNeg ? C.accent : C.border}`, borderRadius: 14, padding: 20, position: "relative", boxShadow: isBest ? `0 0 0 4px rgba(91,95,199,.1)` : isNeg ? `0 0 0 4px rgba(245,158,11,.1)` : "none", transition: "all .2s" }}>
                    {isBest && <div style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", background: C.primary, color: "#fff", padding: "4px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>✓ RECOMMENDED</div>}
                    {isNeg && <div style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", background: `linear-gradient(135deg, ${C.accent}, #d97706)`, color: "#fff", padding: "4px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(245,158,11,.3)" }}>⚡ NEGOTIATED</div>}

                    <h4 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{s.name}</h4>
                    <span style={{ display: "inline-block", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: rc.bg, color: rc.text }}>{s.risk}</span>

                    <div style={{ margin: "16px 0" }}>
                      <div style={{ fontSize: 12, color: C.textMuted }}>ADR Offer</div>
                      <div style={{ fontSize: 28, fontWeight: 700 }}>€{s.adr}</div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                      {[{ l: "Pickup", v: `${s.pickupRate}%` }, { l: "Win Prob.", v: `${s.conversionProb}%` }, { l: "GVI", v: s.gviIndex }].map(m => (
                        <div key={m.l} style={{ textAlign: "center" }}><div style={{ fontSize: 10, color: C.textMuted }}>{m.l}</div><div style={{ fontSize: 17, fontWeight: 700 }}>{m.v}</div></div>
                      ))}
                    </div>

                    <div style={{ background: "#f8fafc", borderRadius: 8, padding: 12, marginBottom: 14 }}>
                      {[{ l: "Room Revenue", v: s.roomRevenue, c: C.hotel }, { l: "F&B Revenue", v: s.fnbRevenue, c: C.anneal }, { l: "Space Revenue", v: s.spaceRevenue, c: C.accent }].map(r => (
                        <div key={r.l} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 13 }}>
                          <span style={{ color: C.textMuted }}>{r.l}</span><span style={{ fontWeight: 600, color: r.c }}>€{r.v.toLocaleString()}</span>
                        </div>
                      ))}
                      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "2px solid #e2e8f0", fontWeight: 700, fontSize: 14 }}>
                        <span>Total Revenue</span><span>€{s.totalRevenue.toLocaleString()}</span>
                      </div>
                    </div>

                    <div style={{ background: "#d1fae5", borderRadius: 8, padding: 12, marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: "#065f46" }}>Expected Profit</span>
                        <span style={{ fontSize: 16, fontWeight: 700, color: "#065f46" }}>€{s.expectedProfit.toLocaleString()}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#059669" }}>
                        <span>ROI vs Baseline</span><span style={{ fontWeight: 700 }}>{s.roiVsBaseline}</span>
                      </div>
                    </div>

                    {isNeg && (
                      <div style={{ display: "flex", gap: 10, marginBottom: 12, padding: 10, background: "#0f172a", borderRadius: 8 }}>
                        <div style={{ flex: 1, textAlign: "center" }}><div style={{ fontSize: 8, color: C.hotel, fontFamily: "monospace" }}>HOTEL U</div><div style={{ fontSize: 14, fontWeight: 700, color: C.hotel, fontFamily: "monospace" }}>{s.hotelU.toFixed(3)}</div></div>
                        <div style={{ flex: 1, textAlign: "center" }}><div style={{ fontSize: 8, color: C.client, fontFamily: "monospace" }}>CLIENT U</div><div style={{ fontSize: 14, fontWeight: 700, color: C.client, fontFamily: "monospace" }}>{s.clientU.toFixed(3)}</div></div>
                      </div>
                    )}

                    <div style={{ marginBottom: 14 }}>
                      <strong style={{ fontSize: 12, display: "block", marginBottom: 5 }}>PACKAGE INCLUDES:</strong>
                      <div style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.6 }}>
                        {s.includes.map((item, j) => <div key={j}>• {item}</div>)}
                      </div>
                    </div>

                    <button style={{ width: "100%", padding: 12, border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", color: isBest || isNeg ? "#fff" : "#4a5568", background: isBest ? C.primary : isNeg ? `linear-gradient(135deg, ${C.accent}, #d97706)` : "#fff", boxShadow: !isBest && !isNeg ? `inset 0 0 0 2px ${C.border}` : "none", transition: "all .15s" }}>
                      {s.subtitle}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── NEGOTIATE TAB ─────────────────────────────────────────────── */}
        {tab === "negotiate" && (
          <div>
            {/* Negotiate header */}
            <div style={{ background: C.dark, borderRadius: 12, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 7, background: `linear-gradient(135deg, ${C.hotel}, ${C.accent})`, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14, fontWeight: 700 }}>N</div>
                <div><div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>Annealing Mediator Protocol</div><div style={{ fontSize: 10, color: C.textDim, fontFamily: "monospace" }}>Klein, Faratin, Sayama & Bar-Yam · Interdependent multi-issue negotiation</div></div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {negPhase !== "config" && <button onClick={() => { setNegPhase("config"); setResult(null); setAnimIdx(0); }} style={{ ...smallBtn, background: "#1e293b", border: `1px solid #334155`, color: "#94a3b8" }}>⚙ Configure</button>}
                {negPhase === "config" && <button onClick={runNeg} style={{ ...smallBtn, background: `linear-gradient(135deg, ${C.hotel}, #2563eb)`, color: "#fff", border: "none" }}>▶ Run Negotiation</button>}
                {negPhase === "results" && <button onClick={runNeg} style={{ ...smallBtn, background: `linear-gradient(135deg, ${C.accent}, #d97706)`, color: "#000", border: "none" }}>↻ Re-run</button>}
              </div>
            </div>

            {/* CONFIG */}
            {negPhase === "config" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.hotel }} />
                    <h4 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>Hotel Utility Weights</h4>
                  </div>
                  <p style={{ fontSize: 11, color: C.textDim, marginBottom: 14, lineHeight: 1.4 }}>Positive = hotel wants more. Negative = concession cost.</p>
                  {ISSUES.map(is => (
                    <div key={is.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 110, fontSize: 11, color: C.textMuted, flexShrink: 0 }}>{is.label}</span>
                      <input type="range" min={-0.5} max={0.5} step={0.01} value={hw[is.key]} onChange={e => setHw(p => ({ ...p, [is.key]: +e.target.value }))} style={{ flex: 1, accentColor: C.hotel }} />
                      <span style={{ width: 36, fontSize: 11, fontFamily: "monospace", fontWeight: 600, textAlign: "right", color: hw[is.key] >= 0 ? C.hotel : "#ef4444" }}>{hw[is.key] > 0 ? "+" : ""}{hw[is.key].toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
                    <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Algorithm Parameters</h4>
                    {[{ k: "maxRounds", l: "Max Rounds", mn: 50, mx: 600, s: 50 }, { k: "initialTemp", l: "Temperature", mn: 0.5, mx: 5, s: 0.1 }, { k: "coolingRate", l: "Cooling Rate", mn: 0.95, mx: 0.999, s: 0.001 }, { k: "initialTokens", l: "Parity Tokens", mn: 1, mx: 10, s: 1 }].map(p => (
                      <div key={p.k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ width: 100, fontSize: 11, color: C.textMuted }}>{p.l}</span>
                        <input type="range" min={p.mn} max={p.mx} step={p.s} value={cfg[p.k]} onChange={e => setCfg(c => ({ ...c, [p.k]: +e.target.value }))} style={{ flex: 1, accentColor: C.anneal }} />
                        <span style={{ width: 40, fontSize: 11, fontFamily: "monospace", color: C.anneal, textAlign: "right" }}>{cfg[p.k]}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
                    <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>How It Works</h4>
                    {["Mediator proposes mutations to current deal", "Both parties vote (strong/weak accept/reject)", "Annealing allows temporary utility decrements", "Token parity prevents strategic exaggeration", "Temperature cools → converges near Pareto"].map((s, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
                        <span style={{ width: 18, height: 18, borderRadius: "50%", background: C.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                        {s}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* RUNNING / RESULTS */}
            {(negPhase === "running" || negPhase === "results") && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ background: C.dark, borderRadius: 12, padding: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", marginBottom: 8 }}>Utility Space & Pareto Frontier</div>
                    <ParetoChart history={vis} pareto={pareto} w={460} h={300} />
                  </div>
                  {negPhase === "running" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ flex: 1, height: 4, background: "#e2e8f0", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${(animIdx / (result?.history.length || 1)) * 100}%`, background: `linear-gradient(90deg, ${C.hotel}, ${C.accent})`, borderRadius: 4, transition: "width .1s" }} />
                      </div>
                      <span style={{ fontSize: 10, fontFamily: "monospace", color: C.textDim }}>{Math.min(animIdx, result?.history.length || 0)}/{result?.history.length || 0}</span>
                      {[2, 8, 20].map(s => (
                        <button key={s} onClick={() => setSpeed(s)} style={{ padding: "2px 8px", fontSize: 10, borderRadius: 4, border: `1px solid ${speed === s ? C.accent : C.border}`, background: speed === s ? C.accent : "#fff", color: speed === s ? "#000" : C.textDim, cursor: "pointer", fontFamily: "monospace" }}>
                          {s === 2 ? "1×" : s === 8 ? "4×" : "10×"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* Stats */}
                  <div style={{ background: C.dark, borderRadius: 10, padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                    {[{ l: "Accept", v: accN, c: C.client }, { l: "Anneal", v: annN, c: C.anneal }, { l: "Override", v: ovrN, c: C.accent }, { l: "Round", v: latest?.round || 0, c: "#e2e8f0" }].map(s => (
                      <div key={s.l} style={{ background: "#1e293b", borderRadius: 6, padding: "5px 8px", textAlign: "center" }}>
                        <div style={{ fontSize: 8, color: C.textDim, fontFamily: "monospace", textTransform: "uppercase" }}>{s.l}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: s.c, fontFamily: "monospace" }}>{s.v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Agreement */}
                  <div style={{ background: C.dark, border: `1px solid ${negPhase === "results" ? C.accent : C.borderDark}`, borderRadius: 10, padding: 14 }}>
                    <h4 style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", margin: "0 0 2px" }}>{negPhase === "results" ? "✦ Final Agreement" : "Current Agreement"}</h4>
                    {negPhase === "results" && <div style={{ fontSize: 10, color: C.accent, fontFamily: "monospace", marginBottom: 10 }}>Best social welfare across all rounds</div>}
                    {ISSUES.map(is => {
                      const a = negPhase === "results" ? final : latest?.agreement;
                      const v = a?.[is.key];
                      let dv = "—";
                      if (v !== undefined) dv = is.type === "binary" ? (v ? "Yes" : "No") : `${is.unit === "€" ? "€" : ""}${v}${is.unit === "%" ? "%" : ""}`;
                      const n = v !== undefined ? norm(is, v) : 0;
                      return (
                        <div key={is.key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span style={{ width: 100, fontSize: 10, color: C.textDim }}>{is.label}</span>
                          <div style={{ flex: 1, height: 5, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${n * 100}%`, background: `linear-gradient(90deg, ${C.hotel}, ${C.client})`, borderRadius: 3, transition: "width .15s" }} />
                          </div>
                          <span style={{ width: 40, textAlign: "right", fontSize: 11, fontWeight: 600, fontFamily: "monospace", color: "#e2e8f0" }}>{dv}</span>
                        </div>
                      );
                    })}
                    {negPhase === "results" && final && (
                      <div style={{ marginTop: 12, padding: 10, background: "rgba(245,158,11,.08)", border: `1px solid rgba(245,158,11,.2)`, borderRadius: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, textAlign: "center" }}>
                        {[{ l: "Hotel U", c: C.hotel, v: hotelUtility(final, hw).toFixed(3) }, { l: "Client U", c: C.client, v: clientUtility(final, cw).toFixed(3) }, { l: "Social W", c: C.accent, v: (hotelUtility(final, hw) + clientUtility(final, cw)).toFixed(3) }].map(u => (
                          <div key={u.l}><div style={{ fontSize: 8, color: u.c, fontFamily: "monospace" }}>{u.l}</div><div style={{ fontSize: 15, fontWeight: 700, color: u.c, fontFamily: "monospace" }}>{u.v}</div></div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Log */}
                  <div style={{ background: C.dark, borderRadius: 10, padding: "10px 14px", flex: 1, minHeight: 0 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", margin: "0 0 6px" }}>Event Log</h4>
                    <div style={{ maxHeight: 160, overflowY: "auto" }}>
                      {[...vis].reverse().slice(0, 25).map((d, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0", fontSize: 9, fontFamily: "monospace" }}>
                          <span style={{ color: "#475569", width: 26 }}>R{d.round}</span>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: d.event === "mutual_accept" ? C.client : d.event === "annealing" ? C.anneal : d.event?.includes("override") ? C.accent : "#ef4444", flexShrink: 0 }} />
                          <span style={{ color: C.textDim, flex: 1 }}>{d.event?.replace(/_/g, " ")}</span>
                          <span style={{ fontSize: 8, color: d.proposer === "hotel" ? C.hotel : C.client }}>{d.proposer || ""}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {negPhase === "results" && (
                    <button onClick={applyNeg} style={{ width: "100%", padding: 12, background: `linear-gradient(135deg, ${C.client}, #059669)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", transition: "all .15s" }}>
                      ✓ Apply as Strategy →
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const smallBtn = { display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .15s" };
