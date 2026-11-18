// Hourly ERA5-based history (Open-Meteo archive) for each route, 7 winters (1 Nov - 31 Mar), 2019/20 - 2025/26.
import fs from 'node:fs';
const sel=JSON.parse(fs.readFileSync('raw/routes-sel.json'));
fs.mkdirSync('raw/hist',{recursive:true});
for(const r of sel){
  const f=`raw/hist/${r.ref}.json`; if(fs.existsSync(f)) continue;
  const url=`https://archive-api.open-meteo.com/v1/archive?latitude=${r.lat}&longitude=${r.lon}&elevation=${r.elev}&start_date=2019-11-01&end_date=2026-03-31&hourly=temperature_2m,dew_point_2m,precipitation,snowfall&timezone=Europe%2FDublin`;
  for(let t=0;t<6;t++){
    const x=await fetch(url);
    if(x.ok){fs.writeFileSync(f,await x.text());console.log('ok',r.ref);break;}
    console.log(r.ref,x.status,(await x.text()).slice(0,100)); await new Promise(s=>setTimeout(s,30000));
  }
  await new Promise(s=>setTimeout(s,1500));
}
