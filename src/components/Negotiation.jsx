import { useState, useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";

// ─── NEGOTIATION ENGINE (Klein et al. Annealing Mediator Protocol) ───────────

const ISSUES = [
  { key: "adr", label: "ADR (€)", min: 140, max: 320, step: 5, type: "continuous" },
  { key: "fnb_credit", label: "F&B Credit/person (€)", min: 0, max: 60, step: 5, type: "continuous" },
  { key: "space_discount", label: "Space Discount (%)", min: 0, max: 70, step: 5, type: "continuous" },
  { key: "comp_rooms", label: "Comp Rooms", min: 0, max: 6, step: 1, type: "continuous" },
  { key: "wifi", label: "Free WiFi", values: [0, 1], type: "binary" },
  { key: "late_checkout", label: "Late Checkout", values: [0, 1], type: "binary" },
  { key: "welcome_reception", label: "Welcome Reception", values: [0, 1], type: "binary" },
  { key: "av_package", label: "AV Package Included", values: [0, 1], type: "binary" },
];

function normalize(issue, val) {
  if (issue.type === "binary") return val;
  return (val - issue.min) / (issue.max - issue.min);
}

function denormalize(issue, norm) {
  if (issue.type === "binary") return Math.round(norm);
  return Math.round((norm * (issue.max - issue.min) + issue.min) / issue.step) * issue.step;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Hotel utility: wants HIGH adr, LOW concessions
function hotelUtility(agreement, weights) {
  const w = weights || { adr: 0.35, fnb_credit: -0.15, space_discount: -0.12, comp_rooms: -0.10, wifi: -0.04, late_checkout: -0.03, welcome_reception: -0.08, av_package: -0.06 };
  let u = 0;
  for (const issue of ISSUES) {
    const norm = normalize(issue, agreement[issue.key]);
    u += (w[issue.key] || 0) * norm;
  }
  // Interdependencies (the key insight from the paper)
  const adrNorm = normalize(ISSUES[0], agreement.adr);
  const fnbNorm = normalize(ISSUES[1], agreement.fnb_credit);
  const spaceNorm = normalize(ISSUES[2], agreement.space_discount);
  // High ADR + low F&B credit = synergy (consistent premium positioning)
  u += 0.06 * adrNorm * (1 - fnbNorm);
  // High space discount + welcome reception = costly bundle
  u -= 0.04 * spaceNorm * agreement.welcome_reception;
  // Comp rooms + late checkout = compounding cost
  u -= 0.03 * normalize(ISSUES[3], agreement.comp_rooms) * agreement.late_checkout;
  return u;
}

// Client utility: wants LOW adr, HIGH concessions
function clientUtility(agreement, weights) {
  const w = weights || { adr: -0.30, fnb_credit: 0.18, space_discount: 0.14, comp_rooms: 0.10, wifi: 0.06, late_checkout: 0.04, welcome_reception: 0.07, av_package: 0.05 };
  let u = 0;
  for (const issue of ISSUES) {
    const norm = normalize(issue, agreement[issue.key]);
    u += (w[issue.key] || 0) * norm;
  }
  // Interdependencies
  const fnbNorm = normalize(ISSUES[1], agreement.fnb_credit);
  const spaceNorm = normalize(ISSUES[2], agreement.space_discount);
  // F&B credit + welcome reception = great hospitality package
  u += 0.05 * fnbNorm * agreement.welcome_reception;
  // Low ADR + AV package = great deal
  u += 0.04 * (1 - normalize(ISSUES[0], agreement.adr)) * agreement.av_package;
  // Space discount + AV = complete meeting solution
  u += 0.03 * spaceNorm * agreement.av_package;
  return u;
}

function randomAgreement() {
  const a = {};
  for (const issue of ISSUES) {
    if (issue.type === "binary") {
      a[issue.key] = Math.random() > 0.5 ? 1 : 0;
    } else {
      const steps = Math.round((issue.max - issue.min) / issue.step);
      a[issue.key] = issue.min + Math.floor(Math.random() * (steps + 1)) * issue.step;
    }
  }
  return a;
}

function mutateAgreement(agreement) {
  const a = { ...agreement };
  const issue = ISSUES[Math.floor(Math.random() * ISSUES.length)];
  if (issue.type === "binary") {
    a[issue.key] = a[issue.key] === 1 ? 0 : 1;
  } else {
    const direction = Math.random() > 0.5 ? 1 : -1;
    const magnitude = Math.ceil(Math.random() * 3);
    a[issue.key] = clamp(a[issue.key] + direction * issue.step * magnitude, issue.min, issue.max);
  }
  return a;
}

function smartMutate(agreement, proposerUtilFn) {
  // Try several mutations, pick the one best for proposer that isn't catastrophic
  let best = null;
  let bestU = -Infinity;
  for (let i = 0; i < 5; i++) {
    const candidate = mutateAgreement(agreement);
    const u = proposerUtilFn(candidate);
    if (u > bestU) {
      bestU = u;
      best = candidate;
    }
  }
  return best || mutateAgreement(agreement);
}

// Vote strength: strong accept = 1, weak accept = 0, weak reject = -1, strong reject = -2
function vote(currentU, lastAcceptedU, temperature) {
  const delta = currentU - lastAcceptedU;
  if (delta > 0.02) return 1;  // strong accept
  if (delta > -0.005) return 0;  // weak accept
  if (delta > -0.03) return -1; // weak reject
  return -2; // strong reject
}

function runNegotiation(hotelWeights, clientWeights, config = {}) {
  const {
    maxRounds = 300,
    initialTemp = 2.0,
    coolingRate = 0.985,
    initialTokens = 4,
  } = config;

  let current = randomAgreement();
  let bestAccepted = { ...current };
  let bestSocialWelfare = -Infinity;
  let temperature = initialTemp;
  let hotelTokens = initialTokens;
  let clientTokens = initialTokens;

  const history = [];
  const hotelU = (a) => hotelUtility(a, hotelWeights);
  const clientU = (a) => clientUtility(a, clientWeights);

  let lastAcceptedHotelU = hotelU(current);
  let lastAcceptedClientU = clientU(current);
  let hotelOverrides = 0;
  let clientOverrides = 0;

  history.push({
    round: 0,
    agreement: { ...current },
    hotelUtility: lastAcceptedHotelU,
    clientUtility: lastAcceptedClientU,
    socialWelfare: lastAcceptedHotelU + lastAcceptedClientU,
    accepted: true,
    temperature,
    hotelVote: 1,
    clientVote: 1,
    hotelTokens,
    clientTokens,
    event: "initial",
  });

  for (let round = 1; round <= maxRounds; round++) {
    // Alternate proposer
    const isHotelProposing = round % 2 === 0;
    const proposerFn = isHotelProposing ? hotelU : clientU;
    const proposal = smartMutate(current, proposerFn);

    const hU = hotelU(proposal);
    const cU = clientU(proposal);
    const sw = hU + cU;

    const hotelVote = vote(hU, lastAcceptedHotelU, temperature);
    const clientVote = vote(cU, lastAcceptedClientU, temperature);
    const aggregateScore = hotelVote + clientVote;

    let accepted = false;
    let event = "rejected";

    if (aggregateScore >= 0) {
      // Both accept or strong overrides weak
      accepted = true;
      event = aggregateScore >= 2 ? "mutual_accept" : "weak_override";
      if (hotelVote < 0 && clientVote > 0) {
        // Client overrode hotel
        if (clientTokens > 0 && (clientOverrides - hotelOverrides) < 3) {
          clientTokens--;
          hotelTokens++;
          clientOverrides++;
          event = "client_override";
        } else {
          accepted = false;
          event = "blocked_no_tokens";
        }
      } else if (clientVote < 0 && hotelVote > 0) {
        if (hotelTokens > 0 && (hotelOverrides - clientOverrides) < 3) {
          hotelTokens--;
          clientTokens++;
          hotelOverrides++;
          event = "hotel_override";
        } else {
          accepted = false;
          event = "blocked_no_tokens";
        }
      }
    } else {
      // Annealing: mediator may accept rejected proposal
      const annealProb = Math.min(1, Math.exp(aggregateScore / temperature));
      if (Math.random() < annealProb * 0.3) {
        accepted = true;
        event = "annealing_accept";
      }
    }

    if (accepted) {
      current = { ...proposal };
      lastAcceptedHotelU = hU;
      lastAcceptedClientU = cU;
      if (sw > bestSocialWelfare) {
        bestSocialWelfare = sw;
        bestAccepted = { ...proposal };
      }
    }

    temperature *= coolingRate;

    history.push({
      round,
      agreement: accepted ? { ...proposal } : { ...current },
      hotelUtility: accepted ? hU : lastAcceptedHotelU,
      clientUtility: accepted ? cU : lastAcceptedClientU,
      socialWelfare: accepted ? sw : lastAcceptedHotelU + lastAcceptedClientU,
      accepted,
      temperature,
      hotelVote,
      clientVote,
      hotelTokens,
      clientTokens,
      event,
      proposer: isHotelProposing ? "hotel" : "client",
    });
  }

  return { history, bestAgreement: bestAccepted, bestSocialWelfare };
}

// ─── PARETO FRONTIER ESTIMATION ──────────────────────────────────────────────

function estimatePareto(hotelWeights, clientWeights, samples = 500) {
  const points = [];
  for (let i = 0; i < samples; i++) {
    const a = randomAgreement();
    points.push({ h: hotelUtility(a, hotelWeights), c: clientUtility(a, clientWeights) });
  }
  // Also add optimized points
  for (let alpha = 0; alpha <= 1; alpha += 0.05) {
    let best = randomAgreement();
    let bestScore = alpha * hotelUtility(best, hotelWeights) + (1 - alpha) * clientUtility(best, clientWeights);
    for (let j = 0; j < 200; j++) {
      const candidate = mutateAgreement(best);
      const score = alpha * hotelUtility(candidate, hotelWeights) + (1 - alpha) * clientUtility(candidate, clientWeights);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    points.push({ h: hotelUtility(best, hotelWeights), c: clientUtility(best, clientWeights) });
  }
  // Extract frontier
  points.sort((a, b) => a.h - b.h);
  const frontier = [];
  let maxC = -Infinity;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].c > maxC) {
      maxC = points[i].c;
      frontier.push(points[i]);
    }
  }
  frontier.sort((a, b) => a.h - b.h);
  return frontier;
}

// ─── VISUALIZATION COMPONENTS ────────────────────────────────────────────────

const COLORS = {
  bg: "#0a0e17",
  surface: "#111827",
  surfaceLight: "#1a2235",
  border: "#2a3550",
  borderLight: "#3a4a6b",
  accent: "#f59e0b",
  accentDim: "rgba(245, 158, 11, 0.15)",
  hotel: "#3b82f6",
  hotelDim: "rgba(59, 130, 246, 0.15)",
  client: "#10b981",
  clientDim: "rgba(16, 185, 129, 0.15)",
  pareto: "#f43f5e",
  paretoDim: "rgba(244, 63, 94, 0.2)",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accept: "#10b981",
  reject: "#ef4444",
  anneal: "#a855f7",
  override: "#f59e0b",
};

function ParetoChart({ history, pareto, width = 540, height = 400 }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !history.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const margin = { top: 24, right: 24, bottom: 48, left: 56 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const allH = history.map((d) => d.hotelUtility).concat(pareto.map((d) => d.h));
    const allC = history.map((d) => d.clientUtility).concat(pareto.map((d) => d.c));

    const xScale = d3.scaleLinear().domain([d3.min(allH) - 0.02, d3.max(allH) + 0.02]).range([0, w]);
    const yScale = d3.scaleLinear().domain([d3.min(allC) - 0.02, d3.max(allC) + 0.02]).range([h, 0]);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Grid
    const xTicks = xScale.ticks(6);
    const yTicks = yScale.ticks(6);
    xTicks.forEach((t) => {
      g.append("line").attr("x1", xScale(t)).attr("x2", xScale(t)).attr("y1", 0).attr("y2", h).attr("stroke", COLORS.border).attr("stroke-width", 0.5).attr("stroke-dasharray", "2,4");
    });
    yTicks.forEach((t) => {
      g.append("line").attr("x1", 0).attr("x2", w).attr("y1", yScale(t)).attr("y2", yScale(t)).attr("stroke", COLORS.border).attr("stroke-width", 0.5).attr("stroke-dasharray", "2,4");
    });

    // Axes
    g.append("g").attr("transform", `translate(0,${h})`).call(d3.axisBottom(xScale).ticks(6).tickFormat(d3.format(".2f"))).selectAll("text").attr("fill", COLORS.textDim).attr("font-size", "10px");
    g.append("g").call(d3.axisLeft(yScale).ticks(6).tickFormat(d3.format(".2f"))).selectAll("text").attr("fill", COLORS.textDim).attr("font-size", "10px");
    g.selectAll(".domain").attr("stroke", COLORS.border);
    g.selectAll(".tick line").attr("stroke", COLORS.border);

    // Axis labels
    svg.append("text").attr("x", margin.left + w / 2).attr("y", height - 6).attr("text-anchor", "middle").attr("fill", COLORS.hotel).attr("font-size", "11px").attr("font-weight", "600").attr("font-family", "'DM Sans', sans-serif").text("Hotel Utility →");
    svg.append("text").attr("transform", `rotate(-90)`).attr("x", -(margin.top + h / 2)).attr("y", 14).attr("text-anchor", "middle").attr("fill", COLORS.client).attr("font-size", "11px").attr("font-weight", "600").attr("font-family", "'DM Sans', sans-serif").text("Client Utility →");

    // Pareto frontier
    if (pareto.length > 1) {
      const line = d3.line().x((d) => xScale(d.h)).y((d) => yScale(d.c)).curve(d3.curveCatmullRom);
      g.append("path").datum(pareto).attr("d", line).attr("fill", "none").attr("stroke", COLORS.pareto).attr("stroke-width", 2).attr("stroke-dasharray", "6,3").attr("opacity", 0.7);
    }

    // Accepted proposals path
    const accepted = history.filter((d) => d.accepted);
    if (accepted.length > 1) {
      const line = d3.line().x((d) => xScale(d.hotelUtility)).y((d) => yScale(d.clientUtility)).curve(d3.curveLinear);
      g.append("path").datum(accepted).attr("d", line).attr("fill", "none").attr("stroke", COLORS.accent).attr("stroke-width", 1.5).attr("opacity", 0.4);
    }

    // All proposal dots (rejected = dim)
    const rejected = history.filter((d) => !d.accepted);
    g.selectAll(".rejected")
      .data(rejected)
      .enter()
      .append("circle")
      .attr("cx", (d) => xScale(d.hotelUtility))
      .attr("cy", (d) => yScale(d.clientUtility))
      .attr("r", 1.5)
      .attr("fill", COLORS.textDim)
      .attr("opacity", 0.15);

    // Accepted dots
    g.selectAll(".accepted")
      .data(accepted)
      .enter()
      .append("circle")
      .attr("cx", (d) => xScale(d.hotelUtility))
      .attr("cy", (d) => yScale(d.clientUtility))
      .attr("r", (d, i) => (i === 0 ? 5 : i === accepted.length - 1 ? 6 : 2.5))
      .attr("fill", (d, i) => (i === 0 ? COLORS.textMuted : i === accepted.length - 1 ? COLORS.accent : COLORS.accent))
      .attr("opacity", (d, i) => (i === accepted.length - 1 ? 1 : 0.6))
      .attr("stroke", (d, i) => (i === accepted.length - 1 ? "#fff" : "none"))
      .attr("stroke-width", 2);

    // Start label
    if (accepted.length > 0) {
      const start = accepted[0];
      g.append("text").attr("x", xScale(start.hotelUtility) + 8).attr("y", yScale(start.clientUtility) + 4).attr("fill", COLORS.textMuted).attr("font-size", "9px").attr("font-family", "'DM Mono', monospace").text("START");
    }
    // End label
    if (accepted.length > 1) {
      const end = accepted[accepted.length - 1];
      g.append("text").attr("x", xScale(end.hotelUtility) + 10).attr("y", yScale(end.clientUtility) + 4).attr("fill", COLORS.accent).attr("font-size", "10px").attr("font-weight", "700").attr("font-family", "'DM Mono', monospace").text("FINAL");
    }
  }, [history, pareto, width, height]);

  return <svg ref={svgRef} width={width} height={height} style={{ background: COLORS.surface, borderRadius: 12 }} />;
}

function TemperatureChart({ history, width = 540, height = 120 }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !history.length) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const margin = { top: 12, right: 24, bottom: 28, left: 56 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const xScale = d3.scaleLinear().domain([0, history.length - 1]).range([0, w]);
    const yScale = d3.scaleLinear().domain([0, d3.max(history, (d) => d.temperature) * 1.1]).range([h, 0]);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Temperature area
    const area = d3.area().x((d, i) => xScale(i)).y0(h).y1((d) => yScale(d.temperature)).curve(d3.curveBasis);
    const gradient = svg.append("defs").append("linearGradient").attr("id", "tempGrad").attr("x1", "0%").attr("y1", "0%").attr("x2", "0%").attr("y2", "100%");
    gradient.append("stop").attr("offset", "0%").attr("stop-color", COLORS.anneal).attr("stop-opacity", 0.4);
    gradient.append("stop").attr("offset", "100%").attr("stop-color", COLORS.anneal).attr("stop-opacity", 0.02);

    g.append("path").datum(history).attr("d", area).attr("fill", "url(#tempGrad)");
    const line = d3.line().x((d, i) => xScale(i)).y((d) => yScale(d.temperature)).curve(d3.curveBasis);
    g.append("path").datum(history).attr("d", line).attr("fill", "none").attr("stroke", COLORS.anneal).attr("stroke-width", 1.5).attr("opacity", 0.8);

    // Event markers on x-axis
    history.forEach((d, i) => {
      if (d.event === "annealing_accept") {
        g.append("line").attr("x1", xScale(i)).attr("x2", xScale(i)).attr("y1", 0).attr("y2", h).attr("stroke", COLORS.anneal).attr("stroke-width", 0.5).attr("opacity", 0.3);
      }
    });

    g.append("g").attr("transform", `translate(0,${h})`).call(d3.axisBottom(xScale).ticks(6).tickFormat((d) => `R${d}`)).selectAll("text").attr("fill", COLORS.textDim).attr("font-size", "9px");
    g.selectAll(".domain").attr("stroke", COLORS.border);
    g.selectAll(".tick line").attr("stroke", COLORS.border);
    svg.append("text").attr("x", margin.left - 8).attr("y", margin.top + 4).attr("text-anchor", "end").attr("fill", COLORS.anneal).attr("font-size", "9px").attr("font-family", "'DM Mono', monospace").text("T°");
  }, [history, width, height]);

  return <svg ref={svgRef} width={width} height={height} style={{ background: COLORS.surface, borderRadius: 8 }} />;
}

function SocialWelfareChart({ history, width = 540, height = 140 }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !history.length) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const margin = { top: 16, right: 24, bottom: 28, left: 56 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;
    const accepted = history.filter((d) => d.accepted);

    const xScale = d3.scaleLinear().domain([0, accepted.length - 1]).range([0, w]);
    const yScaleH = d3.scaleLinear().domain([d3.min(accepted, (d) => d.hotelUtility) - 0.02, d3.max(accepted, (d) => d.hotelUtility) + 0.02]).range([h, 0]);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Hotel utility line
    const hotelLine = d3.line().x((d, i) => xScale(i)).y((d) => yScaleH(d.hotelUtility)).curve(d3.curveBasis);
    g.append("path").datum(accepted).attr("d", hotelLine).attr("fill", "none").attr("stroke", COLORS.hotel).attr("stroke-width", 1.5).attr("opacity", 0.8);

    // Client utility line (same scale for comparison)
    const yScaleC = d3.scaleLinear().domain([d3.min(accepted, (d) => d.clientUtility) - 0.02, d3.max(accepted, (d) => d.clientUtility) + 0.02]).range([h, 0]);
    const clientLine = d3.line().x((d, i) => xScale(i)).y((d) => yScaleC(d.clientUtility)).curve(d3.curveBasis);
    g.append("path").datum(accepted).attr("d", clientLine).attr("fill", "none").attr("stroke", COLORS.client).attr("stroke-width", 1.5).attr("opacity", 0.8);

    g.append("g").attr("transform", `translate(0,${h})`).call(d3.axisBottom(xScale).ticks(6)).selectAll("text").attr("fill", COLORS.textDim).attr("font-size", "9px");
    g.selectAll(".domain").attr("stroke", COLORS.border);
    g.selectAll(".tick line").attr("stroke", COLORS.border);

    // Legend
    [{ label: "Hotel", color: COLORS.hotel, y: 0 }, { label: "Client", color: COLORS.client, y: 14 }].forEach((l) => {
      g.append("line").attr("x1", w - 60).attr("x2", w - 44).attr("y1", l.y + 4).attr("y2", l.y + 4).attr("stroke", l.color).attr("stroke-width", 2);
      g.append("text").attr("x", w - 40).attr("y", l.y + 8).attr("fill", l.color).attr("font-size", "9px").attr("font-family", "'DM Sans', sans-serif").text(l.label);
    });
  }, [history, width, height]);

  return <svg ref={svgRef} width={width} height={height} style={{ background: COLORS.surface, borderRadius: 8 }} />;
}

// ─── MAIN APPLICATION ────────────────────────────────────────────────────────

const defaultRFP = {
  event_name: "European Tech Summit 2026",
  attendees: 200,
  room_block: 120,
  arrival_date: "2026-06-15",
  departure_date: "2026-06-18",
  client_priority: "High",
};

export default function NegotiationApp() {
  const [phase, setPhase] = useState("config"); // config | running | results
  const [result, setResult] = useState(null);
  const [pareto, setPareto] = useState([]);
  const [animIdx, setAnimIdx] = useState(0);
  const [speed, setSpeed] = useState(8);
  const [rfp] = useState(defaultRFP);
  const animRef = useRef(null);

  const [hotelPriorities, setHotelPriorities] = useState({
    adr: 0.35, fnb_credit: -0.15, space_discount: -0.12, comp_rooms: -0.10,
    wifi: -0.04, late_checkout: -0.03, welcome_reception: -0.08, av_package: -0.06,
  });
  const [clientPriorities] = useState({
    adr: -0.30, fnb_credit: 0.18, space_discount: 0.14, comp_rooms: 0.10,
    wifi: 0.06, late_checkout: 0.04, welcome_reception: 0.07, av_package: 0.05,
  });
  const [config, setConfig] = useState({ maxRounds: 300, initialTemp: 2.0, coolingRate: 0.985, initialTokens: 4 });

  const runNeg = useCallback(() => {
    setPhase("running");
    setAnimIdx(0);
    const p = estimatePareto(hotelPriorities, clientPriorities);
    setPareto(p);
    const res = runNegotiation(hotelPriorities, clientPriorities, config);
    setResult(res);
  }, [hotelPriorities, clientPriorities, config]);

  useEffect(() => {
    if (phase !== "running" || !result) return;
    if (animIdx >= result.history.length) {
      setPhase("results");
      return;
    }
    animRef.current = setTimeout(() => setAnimIdx((i) => i + speed), 16);
    return () => clearTimeout(animRef.current);
  }, [phase, animIdx, result, speed]);

  const visibleHistory = result ? result.history.slice(0, Math.min(animIdx, result.history.length)) : [];
  const latest = visibleHistory.length > 0 ? visibleHistory[visibleHistory.length - 1] : null;
  const finalAgreement = result?.bestAgreement;

  const acceptCount = visibleHistory.filter((d) => d.accepted).length;
  const annealCount = visibleHistory.filter((d) => d.event === "annealing_accept").length;
  const overrideCount = visibleHistory.filter((d) => d.event === "hotel_override" || d.event === "client_override").length;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&family=Instrument+Serif&display=swap" rel="stylesheet" />

      {/* Header */}
      <header style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: `linear-gradient(135deg, ${COLORS.hotel}, ${COLORS.accent})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 }}>N</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Negotiation Engine</div>
            <div style={{ fontSize: 11, color: COLORS.textDim, fontFamily: "'DM Mono', monospace" }}>Klein et al. Annealing Mediator Protocol</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {phase !== "config" && (
            <button onClick={() => { setPhase("config"); setResult(null); setAnimIdx(0); }} style={{ ...btnStyle, background: COLORS.surfaceLight, color: COLORS.textMuted, border: `1px solid ${COLORS.border}` }}>
              ← Configure
            </button>
          )}
          {phase === "config" && (
            <button onClick={runNeg} style={{ ...btnStyle, background: `linear-gradient(135deg, ${COLORS.hotel}, #2563eb)`, color: "#fff", border: "none", fontWeight: 600 }}>
              ▶ Run Negotiation
            </button>
          )}
          {phase === "results" && (
            <button onClick={runNeg} style={{ ...btnStyle, background: `linear-gradient(135deg, ${COLORS.accent}, #d97706)`, color: "#000", border: "none", fontWeight: 600 }}>
              ↻ Re-run
            </button>
          )}
        </div>
      </header>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 32px" }}>
        {/* RFP Context Bar */}
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: "16px 24px", marginBottom: 24, display: "flex", gap: 32, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: COLORS.textDim, fontFamily: "'DM Mono', monospace", marginBottom: 2 }}>RFP</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{rfp.event_name}</div>
          </div>
          {[{ label: "Attendees", val: rfp.attendees }, { label: "Room Block", val: rfp.room_block }, { label: "Nights", val: 3 }, { label: "Priority", val: rfp.client_priority }].map((d) => (
            <div key={d.label}>
              <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: "'DM Mono', monospace" }}>{d.label}</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{d.val}</div>
            </div>
          ))}
        </div>

        {phase === "config" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            {/* Hotel Weights */}
            <div style={{ ...cardStyle }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.hotel }} />
                <h3 style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}>Hotel Utility Weights</h3>
              </div>
              <p style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 16, lineHeight: 1.5 }}>
                Positive = hotel wants more. Negative = hotel wants less (concession cost). Interdependencies between issues are modeled automatically.
              </p>
              {ISSUES.map((issue) => (
                <div key={issue.key} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: COLORS.textMuted }}>{issue.label}</span>
                    <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: hotelPriorities[issue.key] >= 0 ? COLORS.hotel : COLORS.reject, fontWeight: 600 }}>
                      {hotelPriorities[issue.key] > 0 ? "+" : ""}{hotelPriorities[issue.key].toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range" min="-0.5" max="0.5" step="0.01"
                    value={hotelPriorities[issue.key]}
                    onChange={(e) => setHotelPriorities((p) => ({ ...p, [issue.key]: parseFloat(e.target.value) }))}
                    style={{ width: "100%", accentColor: COLORS.hotel }}
                  />
                </div>
              ))}
            </div>

            {/* Algorithm Config */}
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div style={{ ...cardStyle }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.anneal }} />
                  <h3 style={{ fontSize: 14, fontWeight: 700 }}>Algorithm Parameters</h3>
                </div>
                {[
                  { key: "maxRounds", label: "Max Rounds", min: 50, max: 600, step: 50 },
                  { key: "initialTemp", label: "Initial Temperature", min: 0.5, max: 5, step: 0.1 },
                  { key: "coolingRate", label: "Cooling Rate", min: 0.95, max: 0.999, step: 0.001 },
                  { key: "initialTokens", label: "Parity Tokens", min: 1, max: 10, step: 1 },
                ].map((p) => (
                  <div key={p.key} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>{p.label}</span>
                      <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: COLORS.anneal }}>{config[p.key]}</span>
                    </div>
                    <input type="range" min={p.min} max={p.max} step={p.step} value={config[p.key]} onChange={(e) => setConfig((c) => ({ ...c, [p.key]: parseFloat(e.target.value) }))} style={{ width: "100%", accentColor: COLORS.anneal }} />
                  </div>
                ))}
              </div>

              <div style={{ ...cardStyle, background: `linear-gradient(135deg, ${COLORS.surface}, ${COLORS.surfaceLight})` }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Protocol Summary</h3>
                <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.7 }}>
                  <p style={{ marginBottom: 8 }}>Based on <strong style={{ color: COLORS.text }}>Klein, Faratin, Sayama & Bar-Yam</strong>'s annealing mediator for complex multi-issue negotiations with interdependent issues.</p>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>
                    <span style={{ color: COLORS.accent }}>①</span><span>Mediator proposes mutations to current agreement</span>
                    <span style={{ color: COLORS.accent }}>②</span><span>Both parties vote with strength (strong/weak accept/reject)</span>
                    <span style={{ color: COLORS.accent }}>③</span><span>Annealing allows temporary utility decrements</span>
                    <span style={{ color: COLORS.accent }}>④</span><span>Token parity prevents strategic exaggeration</span>
                    <span style={{ color: COLORS.accent }}>⑤</span><span>Temperature cools → converges to near-Pareto optimum</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {(phase === "running" || phase === "results") && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24 }}>
            {/* Charts Column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ ...cardStyle, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 700 }}>Utility Space & Pareto Frontier</h3>
                  <div style={{ display: "flex", gap: 12, fontSize: 10, color: COLORS.textDim }}>
                    <span><span style={{ color: COLORS.pareto }}>- -</span> Pareto</span>
                    <span><span style={{ color: COLORS.accent }}>●</span> Accepted</span>
                    <span><span style={{ color: COLORS.textDim }}>·</span> Rejected</span>
                  </div>
                </div>
                <ParetoChart history={visibleHistory} pareto={pareto} width={540} height={360} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ ...cardStyle, padding: 12 }}>
                  <h4 style={{ fontSize: 11, fontWeight: 600, color: COLORS.textDim, marginBottom: 8 }}>Annealing Temperature</h4>
                  <TemperatureChart history={visibleHistory} width={280} height={100} />
                </div>
                <div style={{ ...cardStyle, padding: 12 }}>
                  <h4 style={{ fontSize: 11, fontWeight: 600, color: COLORS.textDim, marginBottom: 8 }}>Utility Trajectories</h4>
                  <SocialWelfareChart history={visibleHistory} width={280} height={100} />
                </div>
              </div>

              {phase === "running" && (
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ flex: 1, height: 4, background: COLORS.surfaceLight, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(animIdx / (result?.history.length || 1)) * 100}%`, background: `linear-gradient(90deg, ${COLORS.hotel}, ${COLORS.accent})`, borderRadius: 4, transition: "width 0.1s" }} />
                  </div>
                  <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: COLORS.textDim }}>
                    {Math.min(animIdx, result?.history.length || 0)} / {result?.history.length || 0}
                  </span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[2, 8, 20].map((s) => (
                      <button key={s} onClick={() => setSpeed(s)} style={{ ...btnStyle, padding: "2px 8px", fontSize: 10, background: speed === s ? COLORS.accent : COLORS.surfaceLight, color: speed === s ? "#000" : COLORS.textDim, border: `1px solid ${speed === s ? COLORS.accent : COLORS.border}` }}>
                        {s === 2 ? "1×" : s === 8 ? "4×" : "10×"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right Panel */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Stats */}
              <div style={{ ...cardStyle }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Negotiation Stats</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { label: "Round", value: latest?.round || 0, color: COLORS.text },
                    { label: "Accepted", value: acceptCount, color: COLORS.accept },
                    { label: "Annealing", value: annealCount, color: COLORS.anneal },
                    { label: "Overrides", value: overrideCount, color: COLORS.override },
                    { label: "Hotel Tokens", value: latest?.hotelTokens ?? config.initialTokens, color: COLORS.hotel },
                    { label: "Client Tokens", value: latest?.clientTokens ?? config.initialTokens, color: COLORS.client },
                    { label: "Temperature", value: (latest?.temperature || config.initialTemp).toFixed(3), color: COLORS.anneal },
                    { label: "Social Welfare", value: (latest?.socialWelfare || 0).toFixed(3), color: COLORS.accent },
                  ].map((s) => (
                    <div key={s.label} style={{ background: COLORS.surfaceLight, borderRadius: 8, padding: "8px 12px" }}>
                      <div style={{ fontSize: 9, color: COLORS.textDim, fontFamily: "'DM Mono', monospace", marginBottom: 2 }}>{s.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: s.color, fontFamily: "'DM Mono', monospace" }}>{s.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Current/Final Agreement */}
              <div style={{ ...cardStyle, borderColor: phase === "results" ? COLORS.accent : COLORS.border }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                  {phase === "results" ? "✦ Final Agreement" : "Current Agreement"}
                </h3>
                {phase === "results" && (
                  <div style={{ fontSize: 10, color: COLORS.accent, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>
                    Best social welfare found across all rounds
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ISSUES.map((issue) => {
                    const agreement = phase === "results" ? finalAgreement : latest?.agreement;
                    const val = agreement?.[issue.key];
                    const displayVal = issue.type === "binary" ? (val ? "Yes" : "No") : (issue.key === "space_discount" ? `${val}%` : issue.key === "adr" || issue.key === "fnb_credit" || issue.key === "comp_rooms" ? `${issue.key === "adr" || issue.key === "fnb_credit" ? "€" : ""}${val}` : val);
                    const norm = val !== undefined ? normalize(issue, val) : 0;
                    return (
                      <div key={issue.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 120, fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }}>{issue.label}</div>
                        <div style={{ flex: 1, height: 6, background: COLORS.surfaceLight, borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${norm * 100}%`, background: `linear-gradient(90deg, ${COLORS.hotel}, ${COLORS.client})`, borderRadius: 3, transition: "width 0.15s" }} />
                        </div>
                        <div style={{ width: 50, textAlign: "right", fontSize: 12, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: COLORS.text }}>{displayVal ?? "—"}</div>
                      </div>
                    );
                  })}
                </div>

                {phase === "results" && finalAgreement && (
                  <div style={{ marginTop: 16, padding: 12, background: COLORS.accentDim, borderRadius: 8, border: `1px solid ${COLORS.accent}33` }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 9, color: COLORS.hotel, fontFamily: "'DM Mono', monospace" }}>Hotel Utility</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.hotel }}>{hotelUtility(finalAgreement, hotelPriorities).toFixed(3)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: COLORS.client, fontFamily: "'DM Mono', monospace" }}>Client Utility</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.client }}>{clientUtility(finalAgreement, clientPriorities).toFixed(3)}</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Event Log */}
              <div style={{ ...cardStyle, flex: 1, minHeight: 0 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Event Log</h3>
                <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  {[...visibleHistory].reverse().slice(0, 40).map((d, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", fontSize: 10, fontFamily: "'DM Mono', monospace" }}>
                      <span style={{ color: COLORS.textDim, width: 32 }}>R{d.round}</span>
                      <span style={{
                        width: 8, height: 8, borderRadius: "50%",
                        background: d.event === "mutual_accept" ? COLORS.accept : d.event === "annealing_accept" ? COLORS.anneal : d.event?.includes("override") ? COLORS.override : d.event === "rejected" ? COLORS.reject : COLORS.textDim,
                        flexShrink: 0,
                      }} />
                      <span style={{ color: COLORS.textMuted, flex: 1 }}>{d.event?.replace(/_/g, " ")}</span>
                      <span style={{ color: d.proposer === "hotel" ? COLORS.hotel : COLORS.client, fontSize: 9 }}>{d.proposer || ""}</span>
                    </div>
                  ))}
                </div>
              </div>

              {phase === "results" && (
                <button onClick={() => alert(`Agreement exported!\n\nADR: €${finalAgreement.adr}\nF&B: €${finalAgreement.fnb_credit}/person\nSpace: ${finalAgreement.space_discount}% off\nComp Rooms: ${finalAgreement.comp_rooms}\nWiFi: ${finalAgreement.wifi ? "Yes" : "No"}\nLate Checkout: ${finalAgreement.late_checkout ? "Yes" : "No"}\nWelcome Reception: ${finalAgreement.welcome_reception ? "Yes" : "No"}\nAV Package: ${finalAgreement.av_package ? "Yes" : "No"}`)} style={{ ...btnStyle, width: "100%", padding: "12px", background: `linear-gradient(135deg, ${COLORS.accept}, #059669)`, color: "#fff", border: "none", fontWeight: 700, fontSize: 14 }}>
                  Apply to RFP Strategy →
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle = {
  padding: "6px 16px",
  borderRadius: 8,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "'DM Sans', system-ui, sans-serif",
  transition: "all 0.15s",
};

const cardStyle = {
  background: COLORS.surface,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  padding: 20,
};
