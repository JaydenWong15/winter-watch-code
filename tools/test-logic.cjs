const fs=require('fs');const L=require('../src/logic.js');const assert=require('assert');
// synthetic checks
const mk=(T,Td,P,S)=>{const time=[];for(let d=0;d<2;d++)for(let h=0;h<24;h++)time.push(`2026-01-0${d+1}T${String(h).padStart(2,'0')}:00`);return{time,temperature_2m:time.map((_,i)=>T(i)),dew_point_2m:time.map((_,i)=>Td(i)),precipitation:time.map((_,i)=>P(i)),snowfall:time.map((_,i)=>S(i))};};
let a=L.assessNight(mk(()=>8,()=>2,()=>0,()=>0),'2026-01-01');assert.equal(a.verdict,'NO GRIT');
a=L.assessNight(mk(i=>i>=24+2&&i<=24+5?-2:5,()=>-3,()=>0,()=>0),'2026-01-01');assert.equal(a.verdict,'GRIT');assert.equal(a.onset,'2026-01-02T02:00');
a=L.assessNight(mk(i=>i>=24+2&&i<=24+5?-2:5,()=>-10,()=>0,()=>0),'2026-01-01');assert.equal(a.verdict,'MARGINAL');
a=L.assessNight(mk(()=>1,()=>-1,()=>0,i=>i==30?0.5:0),'2026-01-01');assert.equal(a.verdict,'GRIT');
// bad values dropped, row kept
const h=mk(()=>3,()=>0,()=>0,()=>0);h.temperature_2m[20]=null;a=L.assessNight(h,'2026-01-01');assert.equal(a.excludedHours,1);
// real data: coldest night and winter counts
const H=JSON.parse(fs.readFileSync('data/history.json'));
console.log('routes',H.routes.length,'M50 nights',H.routes[0].winters.map(w=>w.nights).join(','));
// dispatch on a real cold night
const raw=JSON.parse(fs.readFileSync('raw/hist/M50.json')).hourly;
const dep=[{id:'N',name:'North',lat:53.46,lon:-6.22,trucks:5},{id:'W',name:'West',lat:53.32,lon:-6.40,trucks:5},{id:'C',name:'Central',lat:53.35,lon:-6.27,trucks:4},{id:'S',name:'South',lat:53.28,lon:-6.2,trucks:4}];
let best=null;for(const d of ['2020-12-20','2021-01-05','2022-12-15','2023-01-17','2024-12-10','2025-01-20','2021-02-07'])for(let k=0;k<30;k++){const dt=new Date(Date.UTC(2020,11,1+k*20));}
const nights=[];const hr={};for(const r of H.routes)hr[r.ref]=JSON.parse(fs.readFileSync('raw/hist/'+r.ref+'.json')).hourly;
let cnt=0,pick=null;for(let d=new Date(Date.UTC(2020,11,1));d<new Date(Date.UTC(2021,2,1));d.setUTCDate(d.getUTCDate()+1)){const ds=d.toISOString().slice(0,10);const as={};let g=0;for(const r of H.routes){as[r.ref]=L.assessNight(hr[r.ref],ds);if(as[r.ref]&&as[r.ref].verdict==='GRIT')g++;}if(g>=30&&!pick)pick={ds,as,g};}
console.log('first night with >=30 grit routes',pick&&pick.ds,pick&&pick.g);
const plan=L.planDispatch(H.routes,dep,pick.as);console.log('planned',plan.plan.length,'unmet',plan.unmet.length,JSON.stringify(plan.spare));console.log(plan.plan.slice(0,4));console.log(plan.unmet.slice(0,3));
const rk=L.rankPriorities(H.routes);console.log('q3',rk.q3,'moveUp',rk.rows.filter(r=>r.moveUp).map(r=>r.ref+':'+r.mean).join(' '));
console.log('ALL TESTS PASSED');
