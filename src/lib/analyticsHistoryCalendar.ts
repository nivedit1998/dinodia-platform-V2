export function historyDay(time: number, timezone: string) {
  const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
  }).formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  const midnight = (year:number,month:number,day:number) => {
    const target=Date.UTC(year,month-1,day);let guess=target;
    for(let n=0;n<6;n++){const p=parts(guess);const delta=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);if(!delta)return guess;guess+=delta;}
    throw new Error('Unresolvable analytics calendar boundary');
  };
  const p=parts(time);const next=new Date(Date.UTC(p.year,p.month-1,p.day+1));
  return {date:`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`,
    start:midnight(p.year,p.month,p.day),end:midnight(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate())};
}
export function historyWeek(time:number,timezone:string){
  let day=historyDay(time,timezone);const p=new Date(day.date+'T12:00:00Z');const offset=(p.getUTCDay()+6)%7;
  for(let n=0;n<offset;n++)day=historyDay(day.start-1,timezone);
  let last=day;for(let n=0;n<7;n++)last=historyDay(last.end,timezone);
  return {start:day.start,end:last.start};
}
export function historyYearCutoff(time:number,timezone:string){
  const p=historyDay(time,timezone).date.split('-').map(Number);const last=new Date(Date.UTC(p[0]-1,p[1],0)).getUTCDate();
  const target=`${p[0]-1}-${String(p[1]).padStart(2,'0')}-${String(Math.min(p[2],last)).padStart(2,'0')}`;
  // Resolve the target local date by starting near local noon, then read midnight.
  let candidate=Date.parse(target+'T12:00:00Z');
  for(let n=0;n<3;n++){const d=historyDay(candidate,timezone);if(d.date===target)return d.start;
    candidate+=d.date<target?86400000:-86400000;}
  throw new Error('Unresolvable history retention date');
}
