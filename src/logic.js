/* LOGIC START */
const CFG = { iceT: 0, marginalT: 2, dewGap: 2, snowCm: 0.1, wetLookbackH: 6, bufferMin: 30, spreadKmh: 30, transitKmh: 50, loadMin: 20 };
const TIER = { motorway: 1, trunk: 1, primary: 2, secondary: 3 };
const hav = (a, b, c, d) => { const t = x => x * Math.PI / 180, dl = t(c - a), dn = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const pad2 = x => String(x).padStart(2, '0');
// h = {time[], temperature_2m[], dew_point_2m[], precipitation[], snowfall[]} hourly local time.
// Night starting on date D = D 18:00 .. D+1 08:00 (hours 18-23 and 0-8), i.e. 18:00 to 09:00.
function nightHours(h, dateStr) {
  if (!h._idx) h._idx = new Map(h.time.map((t, i) => [t, i]));
  const next = new Date(dateStr + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1); const d2 = next.toISOString().slice(0, 10);
  const keys = []; for (let x = 18; x < 24; x++) keys.push(dateStr + 'T' + pad2(x) + ':00'); for (let x = 0; x < 9; x++) keys.push(d2 + 'T' + pad2(x) + ':00');
  const ii = keys.map(k => h._idx.get(k)); if (ii.some(i => i === undefined)) return null;
  const lb = []; for (let x = 18 - CFG.wetLookbackH; x < 18; x++) { const i = h._idx.get(dateStr + 'T' + pad2(x) + ':00'); if (i !== undefined) lb.push(i); }
  return { keys, ii, lb };
}
function assessNight(h, dateStr, cfg = CFG) {
  const nh = nightHours(h, dateStr); if (!nh) return null;
  const T = i => h.temperature_2m[i], Td = i => h.dew_point_2m[i], P = i => h.precipitation[i], S = i => h.snowfall[i];
  const bad = v => v == null || !Number.isFinite(v);
  let wetBefore = nh.lb.some(i => !bad(P(i)) && P(i) >= 0.1), ice = 0, marg = 0, snow = 0, snowCm = 0, minT = 99, onset = null, onsetKind = null, excluded = 0;
  nh.ii.forEach((i, n) => {
    const t = T(i); if (bad(t)) { excluded++; return; }
    minT = Math.min(minT, t);
    const p = P(i), wetNow = (!bad(p) && p >= 0.1) || (!bad(Td(i)) && t - Td(i) <= cfg.dewGap);
    const wet = wetNow || wetBefore; if (!bad(p) && p >= 0.1) wetBefore = true;
    const sn = !bad(S(i)) ? S(i) : 0;
    const isSnow = sn >= cfg.snowCm && t <= cfg.marginalT, isIce = t <= cfg.iceT && wet, isMarg = !isIce && ((t <= cfg.marginalT && wet) || t <= cfg.iceT);
    if (isSnow) { snow++; snowCm += sn; } if (isIce) ice++; else if (isMarg) marg++;
    const kind = (isSnow || isIce) ? 'ice' : isMarg ? 'marginal' : null;
    if (kind && (onset === null || (kind === 'ice' && onsetKind !== 'ice'))) { onset = nh.keys[n]; onsetKind = kind; }
  });
  const verdict = (snow || ice) ? 'GRIT' : marg ? 'MARGINAL' : 'NO GRIT';
  return { date: dateStr, verdict, minT: minT === 99 ? null : +minT.toFixed(1), iceHours: ice, marginalHours: marg, snowHours: snow, snowCm: +snowCm.toFixed(1), onset, excludedHours: excluded };
}
const fmtTime = k => k ? k.slice(11, 16) : null;
// Dispatch plan: code decides departure times; the AI only explains.
function planDispatch(routes, depots, assessments, cfg = CFG) {
  const todo = routes.map(r => ({ r, a: assessments[r.ref] })).filter(x => x.a && x.a.verdict === 'GRIT' && x.a.onset);
  const nearest = r => depots.map(d => ({ d, km: hav(r.lat, r.lon, d.lat, d.lon) })).sort((a, b) => a.km - b.km)[0];
  const toMin = k => new Date(k + ':00Z').getTime() / 60000;
  const fromMin = m => new Date(m * 60000).toISOString().slice(0, 16);
  const trucks = {}; depots.forEach(d => { trucks[d.id] = Array.from({ length: d.trucks }, () => ({ free: -Infinity, runs: 0 })); });
  const jobs = todo.map(({ r, a }) => { const n = nearest(r); const run = Math.round(r.km / cfg.spreadKmh * 60 + n.km / cfg.transitKmh * 60 + cfg.loadMin); return { r, a, depot: n.d, transitKm: +n.km.toFixed(1), runMin: run, deadline: toMin(a.onset) - cfg.bufferMin }; })
    .sort((x, y) => x.deadline - y.deadline || TIER[x.r.cls] - TIER[y.r.cls]);
  const out = [], unmet = [];
  for (const j of jobs) {
    const t = trucks[j.depot.id].slice().sort((a, b) => a.free - b.free)[0];
    const depart = j.deadline - j.runMin;
    if (!t) { unmet.push({ ...j, reason: 'no truck at ' + j.depot.name }); continue; }
    if (t.free > depart) { unmet.push({ ...j, reason: 'trucks at ' + j.depot.name + ' are busy until ' + fromMin(t.free).slice(11) + ', after the latest safe departure ' + fromMin(depart).slice(11) }); continue; }
    t.free = depart + j.runMin; t.runs++;
    out.push({ ref: j.r.ref, name: j.r.name, km: j.r.km, depot: j.depot.name, depart: fromMin(depart), finish: fromMin(depart + j.runMin), onset: j.a.onset, runMin: j.runMin });
  }
  const spare = depots.map(d => ({ depot: d.name, trucks: d.trucks, used: trucks[d.id].filter(t => t.runs > 0).length, spare: trucks[d.id].filter(t => t.runs === 0).length }));
  const alts = unmet.map(u => { const c = spare.filter(s => s.depot !== u.depot.name && s.spare > 0).map(s => { const d = depots.find(x => x.name === s.depot); return { s, km: hav(u.r.lat, u.r.lon, d.lat, d.lon) }; }).sort((a, b) => a.km - b.km)[0];
    return { ref: u.r.ref, reason: u.reason, suggestion: c ? 'Send a spare truck from ' + c.s.depot + ' (' + c.km.toFixed(0) + ' km away). Needs engineer approval.' : 'No spare truck anywhere: treat as soon as a truck is free, or accept the risk. Needs engineer approval.' }; });
  out.sort((a, b) => a.depart.localeCompare(b.depart));
  return { plan: out, unmet: alts, spare };
}
// History summary: fetched once, summarised in code (only the summary goes to the AI).
function summariseWinters(h, firstYear, lastYear) {
  const res = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const w = { winter: y + '/' + String(y + 1).slice(2), nights: 0, grit: 0, marginal: 0, snow: 0, minT: 99, excluded: 0 };
    for (let d = new Date(Date.UTC(y, 10, 1)); d < new Date(Date.UTC(y + 1, 3, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
      const a = assessNight(h, d.toISOString().slice(0, 10)); if (!a) continue;
      w.nights++; if (a.verdict === 'GRIT') w.grit++; else if (a.verdict === 'MARGINAL') w.marginal++; if (a.snowHours) w.snow++; if (a.minT !== null) w.minT = Math.min(w.minT, a.minT); w.excluded += a.excludedHours;
    }
    res.push(w);
  }
  return res;
}
// Next-winter priority ranking. Code ranks; the AI only recommends in words. Rule: a route moves up to P2 when it is not already P1/P2
// and its mean grit-nights per winter is in the top quarter of all routes. P1 stays for motorway/trunk class (strategic roads).
function rankPriorities(routes) {
  const rows = routes.map(r => {
    const g = r.winters.map(w => w.grit), mean = g.reduce((a, b) => a + b, 0) / g.length;
    const early = g.slice(0, 4).reduce((a, b) => a + b, 0) / 4, late = g.slice(4).reduce((a, b) => a + b, 0) / 3;
    return { ref: r.ref, name: r.name, cls: r.cls, km: r.km, elev: r.elev, tier: TIER[r.cls], mean: +mean.toFixed(1), min: Math.min(...g), max: Math.max(...g), early: +early.toFixed(1), late: +late.toFixed(1), coldest: Math.min(...r.winters.map(w => w.minT)), sources: 'history.json' };
  });
  const sorted = rows.map(r => r.mean).sort((a, b) => a - b);
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  rows.forEach(r => { r.moveUp = r.tier === 3 && r.mean >= q3; r.suggestedTier = r.moveUp ? 2 : r.tier; });
  rows.sort((a, b) => (b.moveUp - a.moveUp) || (b.mean - a.mean) || (b.elev - a.elev));
  return { rows, q3 };
}
// ---- Chat retrieval: pick the slices of the same data the page uses (forecast, roads, history, plan, ranking) that match the question. ----
// The AI only sees these slices, and the page lists them under each answer so every number has a source.
function buildContext(q, d) {
  const text = String(q || '').toLowerCase(), blocks = [], sources = [];
  const R = d.hist.routes, add = (label, src, body) => { blocks.push('## ' + label + '\n' + (typeof body === 'string' ? body : JSON.stringify(body))); if (!sources.includes(src)) sources.push(src); };
  const FC = 'Open-Meteo forecast', HI = 'Open-Meteo archive (ERA5), 7 winters', OSM = 'OpenStreetMap roads', RULE = 'Winter Watch rules (code)', ASM = 'Assumed fleet and tiers';
  // tonight summary
  if (d.fetchedAt) {
    const grit = R.filter(r => d.assess[r.ref]?.verdict === 'GRIT'), marg = R.filter(r => d.assess[r.ref]?.verdict === 'MARGINAL');
    const cold = R.map(r => ({ ref: r.ref, minT: d.assess[r.ref]?.minT })).filter(x => x.minT != null).sort((a, b) => a.minT - b.minT);
    add('Tonight (night of ' + d.night + ', 18:00-09:00 Irish time; forecast fetched ' + d.fetchedAt + ')', FC, { countyVerdict: d.county, routesToGrit: grit.map(r => r.ref), marginalRoutes: marg.map(r => r.ref), coldest5: cold.slice(0, 5), rules: 'GRIT = air temp <= ' + CFG.iceT + 'C on a wet surface, or snow; MARGINAL = <= ' + CFG.marginalT + 'C and wet, or dry frost' });
  } else blocks.push('## Tonight\nThe live forecast has not been fetched yet.');
  add('Route index (ref, name, class, current tier, carriageway-km, height m, average grit nights per winter over 7 winters)', OSM, R.map(r => [r.ref, r.name, r.cls, 'P' + TIER[r.cls], r.km, r.elev, +(r.winters.reduce((s, w) => s + w.grit, 0) / r.winters.length).toFixed(1)]));
  // routes named in the question
  const hit = new Set(); (text.match(/\b[mnr]\d{1,3}\b/g) || []).forEach(x => hit.add(x.toUpperCase()));
  R.forEach(r => { if (r.name && r.name.length >= 5 && text.includes(r.name.toLowerCase())) hit.add(r.ref); });
  const named = R.filter(r => hit.has(r.ref)).slice(0, 4);
  for (const r of named) {
    const a = d.assess[r.ref], hrs = d.hourlyFor && d.fetchedAt ? d.hourlyFor(r.ref) : null, pl = d.plan && d.plan.plan.find(p => p.ref === r.ref), rk = d.rank && d.rank.rows.find(x => x.ref === r.ref);
    add('Route ' + r.ref + ' ' + r.name, HI + '; ' + FC, { class: r.cls, tier: 'P' + TIER[r.cls], km: r.km, heightM: r.elev, tonight: a || 'no forecast', hourlyTonight: hrs, dispatch: pl || null, historyByWinter: r.winters.map(w => ({ winter: w.winter, gritNights: w.grit, marginalNights: w.marginal, snowNights: w.snow, coldestC: w.minT })), priorityRule: rk ? { avgGritNights: rk.mean, suggestion: rk.moveUp ? 'move up to P2' : 'keep P' + rk.tier } : null });
  }
  // history
  if (/histor|winter|past|year|last|20\d\d|record|coldest|worst|trend|average/.test(text)) {
    const per = d.hist.winters.map((w, i) => ({ winter: w, avgGritNightsPerRoute: +(R.reduce((s, r) => s + r.winters[i].grit, 0) / R.length).toFixed(1), nights: R[0].winters[i].nights, coldestC: Math.min(...R.map(r => r.winters[i].minT)), avgSnowNights: +(R.reduce((s, r) => s + r.winters[i].snow, 0) / R.length).toFixed(1) }));
    add('Network history by winter (1 Nov-31 Mar, nights 18:00-09:00)', HI, per);
    const yr = (text.match(/20\d\d/) || [])[0];
    if (yr) { const i = d.hist.winters.findIndex(w => w.startsWith(yr)); if (i >= 0) add('Routes in winter ' + d.hist.winters[i] + ' (top 10 by grit nights)', HI, R.map(r => ({ ref: r.ref, grit: r.winters[i].grit, marginal: r.winters[i].marginal, snow: r.winters[i].snow, coldestC: r.winters[i].minT })).sort((a, b) => b.grit - a.grit).slice(0, 10)); }
  }
  // priorities
  if (/priorit|move up|next winter|upgrade|tier|rank|invest|which route/.test(text) && d.rank) add('Next-winter priority ranking (top 12). Rule: P3 route moves to P2 if average grit nights >= ' + d.rank.q3 + '. Tiers assumed from road class.', HI + '; ' + ASM + '; ' + RULE, d.rank.rows.slice(0, 12).map(r => ({ ref: r.ref, name: r.name, now: 'P' + r.tier, avgGrit: r.mean, range: r.min + '-' + r.max, heightM: r.elev, suggestion: r.moveUp ? 'move up to P2' : 'keep' })));
  // trucks
  if (/truck|depot|depart|leave|spare|fleet|dispatch|schedule|when/.test(text) && d.plan) add('Dispatch plan and fleet (fleet numbers are assumptions)', RULE + '; ' + ASM, { depots: d.depots.map(x => ({ name: x.name, trucks: x.trucks })), spare: d.plan.spare, departures: d.plan.plan.map(p => ({ ref: p.ref, depot: p.depot, depart: p.depart.slice(11), finish: p.finish.slice(11), riskStarts: p.onset.slice(11) })), notCovered: d.plan.unmet });
  // tonight detail
  if (d.fetchedAt && /tonight|forecast|cold|temperature|ice|frost|snow|rain|grit|marginal|freeze|today|now/.test(text) && !named.length) {
    const rows = R.map(r => ({ ref: r.ref, ...(d.assess[r.ref] || {}) })).filter(x => x.verdict).sort((a, b) => a.minT - b.minT).slice(0, 12);
    add('Tonight by route (12 coldest)', FC + '; ' + RULE, rows);
  }
  return { text: blocks.join('\n\n'), sources };
}
/* LOGIC END */
if (typeof module !== 'undefined') module.exports = { CFG, TIER, hav, assessNight, planDispatch, summariseWinters, nightHours, fmtTime, rankPriorities, buildContext };
