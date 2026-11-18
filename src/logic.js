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
/* LOGIC END */
if (typeof module !== 'undefined') module.exports = { CFG, TIER, hav, assessNight, planDispatch, summariseWinters, nightHours, fmtTime, rankPriorities };
