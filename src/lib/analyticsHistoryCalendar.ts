const formatters = new Map<string, Intl.DateTimeFormat>(), boundaries = new Map<string, number>();
export function historyDay(time: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) { if (formatters.size >= 64) formatters.clear(); formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
  }); formatters.set(timezone, formatter); }
  const parts = (ms: number) => Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  const midnight = (year:number,month:number,day:number) => {
    const key = `${timezone}|${year}-${month}-${day}`;
    if (boundaries.has(key)) return boundaries.get(key)!;
    const target = Date.UTC(year, month - 1, day);
    let low = target - 36 * 3600000, high = target + 36 * 3600000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2), p = parts(mid);
      if (Date.UTC(p.year, p.month - 1, p.day) < target) low = mid + 1; else high = mid;
    }
    if (boundaries.size >= 512) boundaries.clear(); boundaries.set(key, low); return low;
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

export function historyDayExpiry(time:number, timezone:string) {
  const [year, month, day] = historyDay(time, timezone).date.split('-').map(Number);
  const last = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  const target = `${year + 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  let candidate = Date.parse(target + 'T12:00:00Z');
  for (let n = 0; n < 3; n++) {
    const d = historyDay(candidate, timezone);
    if (d.date === target) return d.end;
    candidate += d.date < target ? 86400000 : -86400000;
  }
  throw new Error('Unresolvable daily expiry');
}
