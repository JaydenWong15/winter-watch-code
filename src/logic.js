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
// ---- Chat retrieval: pick the slices of the same data the page uses (forecast, roads, history, plan, ranking) that match the question
// AND the conversation so far (so "the next closest area" or "what about there?" resolves to what was just discussed).
// The AI only sees these slices; the page lists them under each answer so every number has a source.
const AREA_WORDS = { 'North (Fingal)': /\b(north|fingal|swords|balbriggan|howth|malahide)\b/, 'West (South Dublin)': /\b(west|south dublin|tallaght|lucan|clondalkin|blanchardstown)\b/, 'Central (Dublin City)': /\b(central|city centre|dublin city|city)\b/, 'South (Dún Laoghaire-Rathdown)': /\b(south|dlr|dun laoghaire|dún laoghaire|rathdown|bray|dalkey)\b/ };
function areaOf(r, depots) { return depots.map(x => ({ n: x.name, k: hav(r.lat, r.lon, x.lat, x.lon) })).sort((a, b) => a.k - b.k)[0].n; }
const tC = v => v == null ? 'n/a' : (+v).toFixed(1) + '°C';
function buildContext(q, d, history) {
  history = history || [];
  const text = String(q || '').toLowerCase(), blocks = [], sources = [];
  const prior = history.slice(-2).map(h => h.q + ' ' + h.a).join(' ').toLowerCase();
  const short = text.split(/\s+/).length <= 8;                     // short question = probably a follow-up
  const focus = text + ' ' + prior;                                // for finding WHO/WHERE is being talked about
  const intent = short ? text + ' ' + history.slice(-1).map(h => h.q).join(' ').toLowerCase() : text; // for finding WHAT is being asked
  const R = d.hist.routes, add = (label, src, body) => { blocks.push('## ' + label + '\n' + (typeof body === 'string' ? body : JSON.stringify(body))); if (!sources.includes(src)) sources.push(src); };
  const FC = 'Open-Meteo forecast', HI = 'Open-Meteo archive (ERA5), 7 winters', OSM = 'OpenStreetMap roads', RULE = 'Winter Watch rules (code)', ASM = 'Assumed fleet and tiers';
  const area = Object.fromEntries(R.map(r => [r.ref, areaOf(r, d.depots)]));
  const lowest = r => d.assess[r.ref]?.minT;
  if (d.fetchedAt) {
    const grit = R.filter(r => d.assess[r.ref]?.verdict === 'GRIT'), marg = R.filter(r => d.assess[r.ref]?.verdict === 'MARGINAL');
    const cold = R.filter(r => lowest(r) != null).sort((a, b) => lowest(a) - lowest(b));
    add('Tonight, night of ' + d.night + ' (18:00 to 09:00 Irish time), forecast fetched ' + d.fetchedAt, FC, { overallVerdict: d.county, routesThatNeedGrit: grit.map(r => r.ref), marginalRoutes: marg.map(r => r.ref), coldestFiveRoutes: cold.slice(0, 5).map(r => r.ref + ' ' + tC(lowest(r))), warmestFiveRoutes: cold.slice(-5).reverse().map(r => r.ref + ' ' + tC(lowest(r))), ruleUsed: 'GRIT = air at or below ' + CFG.iceT + '°C on a wet surface, or snow. MARGINAL = at or below ' + CFG.marginalT + '°C and wet, or dry frost.' });
  } else blocks.push('## Tonight\nThe live forecast has not been fetched yet.');
  add('Route list: ref, name, road type, area, current tier, km, height in metres, average grit nights per winter (7 winters)', OSM, R.map(r => [r.ref, r.name, r.cls, area[r.ref], 'P' + TIER[r.cls], r.km, r.elev, +(r.winters.reduce((s, w) => s + w.grit, 0) / r.winters.length).toFixed(1)]));
  // who is being talked about (this question first, then the recent conversation)
  const hit = new Set(); (focus.match(/\b[mnr]\d{1,3}\b/g) || []).forEach(x => hit.add(x.toUpperCase()));
  R.forEach(r => { if (r.name && r.name.length >= 5 && focus.includes(r.name.toLowerCase())) hit.add(r.ref); });
  const fromQ = new Set((text.match(/\b[mnr]\d{1,3}\b/g) || []).map(x => x.toUpperCase())); R.forEach(r => { if (r.name && r.name.length >= 5 && text.includes(r.name.toLowerCase())) fromQ.add(r.ref); });
  const ordered = [...fromQ, ...[...hit].filter(x => !fromQ.has(x))];
  const named = ordered.map(ref => R.find(r => r.ref === ref)).filter(Boolean).slice(0, 4);
  const areasHit = Object.keys(AREA_WORDS).filter(n => AREA_WORDS[n].test(focus));
  const wantsTemp = /temp|warm|cold|mild|hot|degree|°|freez|frost|ice|snow|rain|where|region|area|compare|near|close|next|other|which|lowest|highest|colder|warmer|forecast|tonight/.test(intent);
  const nearest = (r, n) => R.filter(x => x.ref !== r.ref).map(x => ({ x, k: hav(r.lat, r.lon, x.lat, x.lon) })).sort((a, b) => a.k - b.k).slice(0, n);
  for (const r of named) {
    const a = d.assess[r.ref], hrs = d.hourlyFor && d.fetchedAt ? d.hourlyFor(r.ref) : null, pl = d.plan && d.plan.plan.find(p => p.ref === r.ref), rk = d.rank && d.rank.rows.find(x => x.ref === r.ref);
    add('Route ' + r.ref + ' ' + r.name + ' (' + area[r.ref] + ')', HI + '; ' + FC, { roadType: r.cls, tier: 'P' + TIER[r.cls], km: r.km, heightM: r.elev, tonight: a ? { verdict: a.verdict, lowest: tC(a.minT), riskStarts: fmtTime(a.onset) } : 'forecast not fetched', hourlyTonight: hrs ? hrs.map(h => h.t + ' ' + tC(h.tempC) + (h.rainMm ? ' rain ' + h.rainMm + 'mm' : '') + (h.snowCm ? ' snow ' + h.snowCm + 'cm' : '')) : null, truckDeparture: pl ? { depot: pl.depot, leaves: fmtTime(pl.depart), finishes: fmtTime(pl.finish) } : null, nextWinterRule: rk ? { avgGritNights: rk.mean, suggestion: rk.moveUp ? 'move up to P2' : 'keep P' + rk.tier } : null, byWinter: r.winters.map(w => w.winter + ': ' + w.grit + ' grit nights, ' + w.marginal + ' marginal, ' + w.snow + ' snow nights, coldest ' + tC(w.minT)), closestRoutesNearby: nearest(r, 4).map(n => n.x.ref + ' ' + n.x.name + ', ' + n.k.toFixed(1) + ' km away' + (d.fetchedAt ? ', tonight lowest ' + tC(lowest(n.x)) : '')) });
  }
  // tonight across every route and area (answers warmest/coldest/compare/next-closest questions)
  if (d.fetchedAt && (wantsTemp || areasHit.length)) {
    add('Tonight, lowest forecast temperature for every route (ref name, area, lowest, verdict)', FC + '; ' + RULE, R.filter(r => d.assess[r.ref]).map(r => r.ref + ' ' + r.name + ', ' + area[r.ref] + ', ' + tC(lowest(r)) + ', ' + d.assess[r.ref].verdict));
    const names = d.depots.map(x => x.name), cen = {};
    names.forEach(n => { const rs = R.filter(r => area[r.ref] === n && d.assess[r.ref]); if (!rs.length) return; const s = rs.slice().sort((a, b) => lowest(a) - lowest(b)); cen[n] = { lat: rs.reduce((t, r) => t + r.lat, 0) / rs.length, lon: rs.reduce((t, r) => t + r.lon, 0) / rs.length, avgLowest: tC(rs.reduce((t, r) => t + lowest(r), 0) / rs.length), coldestRoute: s[0].ref + ' ' + tC(lowest(s[0])), warmestRoute: s.at(-1).ref + ' ' + tC(lowest(s.at(-1))), routes: rs.length }; });
    add('Tonight by area, with the other areas listed nearest first', FC, Object.entries(cen).map(([n, c]) => ({ area: n, averageLowest: c.avgLowest, coldest: c.coldestRoute, warmest: c.warmestRoute, routes: c.routes, nearestAreas: Object.entries(cen).filter(([m]) => m !== n).map(([m, o]) => ({ m, k: hav(c.lat, c.lon, o.lat, o.lon) })).sort((a, b) => a.k - b.k).map(o => o.m + ' (' + o.k.toFixed(0) + ' km, avg ' + cen[o.m].avgLowest + ')') })));
  }
  // history
  if (/histor|winter|past|year|last|20\d\d|record|coldest|worst|trend|average|ever/.test(intent)) {
    const per = d.hist.winters.map((w, i) => ({ winter: w, avgGritNightsPerRoute: +(R.reduce((s, r) => s + r.winters[i].grit, 0) / R.length).toFixed(1), nights: R[0].winters[i].nights, coldestNight: tC(Math.min(...R.map(r => r.winters[i].minT))), avgSnowNights: +(R.reduce((s, r) => s + r.winters[i].snow, 0) / R.length).toFixed(1) }));
    add('Network history by winter (1 Nov to 31 Mar, nights 18:00 to 09:00)', HI, per);
    const yr = (focus.match(/20\d\d/) || [])[0];
    if (yr) { const i = d.hist.winters.findIndex(w => w.startsWith(yr)); if (i >= 0) add('Routes in winter ' + d.hist.winters[i] + ' (top 10 by grit nights)', HI, R.map(r => ({ ref: r.ref, gritNights: r.winters[i].grit, marginalNights: r.winters[i].marginal, snowNights: r.winters[i].snow, coldest: tC(r.winters[i].minT) })).sort((a, b) => b.gritNights - a.gritNights).slice(0, 10)); }
  }
  // priorities
  if (/priorit|move up|next winter|upgrade|tier|rank|invest|which route|highest/.test(intent) && d.rank) add('Next-winter priority ranking, top 12. Rule: a P3 route moves to P2 if its average grit nights is at least ' + d.rank.q3 + '. Tiers are assumed from road class.', HI + '; ' + ASM + '; ' + RULE, d.rank.rows.slice(0, 12).map(r => ({ ref: r.ref, name: r.name, now: 'P' + r.tier, avgGritNights: r.mean, range: r.min + ' to ' + r.max, heightM: r.elev, suggestion: r.moveUp ? 'move up to P2' : 'keep' })));
  // trucks
  if (/truck|depot|depart|leave|spare|fleet|dispatch|schedule|when/.test(intent) && d.plan) add('Truck plan and fleet (fleet numbers are assumptions)', RULE + '; ' + ASM, { depots: d.depots.map(x => x.name + ': ' + x.trucks + ' trucks'), spareTrucks: d.plan.spare.map(s => s.depot + ': ' + s.spare + ' spare'), departures: d.plan.plan.map(p => p.ref + ' leaves ' + fmtTime(p.depart) + ' from ' + p.depot + ', finishes ' + fmtTime(p.finish) + ', risk starts ' + fmtTime(p.onset)), notCovered: d.plan.unmet });
  return { text: blocks.join('\n\n'), sources };
}
/* LOGIC END */
if (typeof module !== 'undefined') module.exports = { CFG, TIER, hav, assessNight, planDispatch, summariseWinters, nightHours, fmtTime, rankPriorities, buildContext };
