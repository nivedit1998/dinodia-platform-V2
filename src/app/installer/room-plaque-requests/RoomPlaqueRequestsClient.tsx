'use client';
import { useEffect, useRef, useState } from 'react';
type Item={areaId:string;roomLabel:string;roomLabelSnapshot:string;kind:string;areaActive:boolean;generation:number|null};
type Order={id:string;reference:string;homeId:string;status:string;revision:number;notes:string;items:Item[];address?:string;blockedReason?:string|null;createdAt:string};
type Plaque={areaId:string;roomLabel:string;roomLabelSnapshot:string;image:string;generation:number};
const labels:Record<string,string>={REQUESTED:'Requested',IN_PRODUCTION:'In production',DISPATCHED:'Dispatched',COMPLETED:'Completed',CANCELLED:'Cancelled'};
export default function RoomPlaqueRequestsClient() {
  const [orders,setOrders]=useState<Order[]>([]),[order,setOrder]=useState<Order|null>(null),[plaques,setPlaques]=useState<Plaque[]>([]);
  const [filter,setFilter]=useState('REQUESTED'),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const keys=useRef(new Map<string,string>());
  const printing=useRef(false);
  async function api(path:string,init:RequestInit={}) {
    const response=await fetch(`/api/company/room-plaque-requests${path}`,{credentials:'same-origin',cache:'no-store',...init});
    const data=await response.json();if(!response.ok) {setPlaques([]);throw new Error(data.error?.message||(typeof data.error==='string'?data.error:'The request could not be completed. Refresh and try again.'));}return data;
  }
  async function load(after:string|null=null) {
    setBusy(true);setError('');try {
      const data=await api(`?${new URLSearchParams({...filter?{status:filter}:{},...after?{after}:{}})}`);
      setOrders(old=>after?[...old,...data.requests]:data.requests);setCursor(data.nextCursor);
    }catch(e){setError(e instanceof Error?e.message:'Unable to load requests');}finally{setBusy(false);}
  }
  useEffect(()=>{void load(); /* Loading follows the selected filter, not background polling. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[filter]);
  useEffect(()=>{
    const clearWhenHidden=()=>{if(document.hidden&&!printing.current)setPlaques([]);};
    const afterPrint=()=>{printing.current=false;setPlaques([]);};
    const clearOnExit=()=>{printing.current=false;setPlaques([]);};
    document.addEventListener('visibilitychange',clearWhenHidden);window.addEventListener('afterprint',afterPrint);window.addEventListener('pagehide',clearOnExit);
    return ()=>{document.removeEventListener('visibilitychange',clearWhenHidden);window.removeEventListener('afterprint',afterPrint);window.removeEventListener('pagehide',clearOnExit);};
  },[]);
  async function detail(id:string) {
    setPlaques([]);setBusy(true);setError('');try{setOrder((await api(`/${id}`)).request);}catch(e){setError(e instanceof Error?e.message:'Unable to load request');}finally{setBusy(false);}
  }
  async function transition(action:string) {
    if(!order||!window.confirm(action==='START_PRODUCTION'?'Start production and issue any missing room codes?':action==='DISPATCH'?'Confirm these plaques have actually been dispatched.':action==='COMPLETE'?'Confirm this physical order is complete.':'Cancel this requested order?'))return;
    setBusy(true);setError('');const identity=`${order.id}:${order.revision}:${action}`;
    if(!keys.current.has(identity))keys.current.set(identity,crypto.randomUUID());
    try {
      await api(`/${order.id}/transition`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':keys.current.get(identity)!},body:JSON.stringify({action,expectedRevision:order.revision})});
      keys.current.delete(identity);await detail(order.id);await load();
    }catch(e){setError(e instanceof Error?e.message:'Outcome uncertain. Retry the same action or refresh its status.');}finally{setBusy(false);}
  }
  async function preparePrint() {
    if(!order)return;setBusy(true);setError('');setPlaques([]);
    try{const data=await api(`/${order.id}/print`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:order.revision})});setPlaques(data.plaques);}
    catch(e){setError(e instanceof Error?e.message:'Unable to prepare printing');}finally{setBusy(false);}
  }
  return <>
    <section className="plaque-controls space-y-4">
      <a className="underline" href="/installer">Back to Company Portal</a>
      <div className="flex flex-wrap gap-3"><label>Status <select value={filter} onChange={e=>{setOrder(null);setPlaques([]);setFilter(e.target.value);}} className="rounded border p-2"><option value="">All</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button disabled={busy} onClick={()=>void load()} className="rounded border px-4 py-2">Refresh requests</button></div>
      {error&&<p role="alert" className="text-red-700">{error}</p>}
      {busy&&<p role="status">Loading…</p>}
      {!busy&&!orders.length&&<p>No requests in this queue.</p>}
      <ul className="space-y-3">{orders.map(row=><li key={row.id} className="rounded-xl border p-4"><button className="text-left underline" onClick={()=>void detail(row.id)} disabled={busy}>{row.reference} · {labels[row.status]} · {row.items.map(item=>item.roomLabel).join(', ')}</button><p className="text-sm">{new Date(row.createdAt).toLocaleString()}</p></li>)}</ul>
      {cursor&&<button disabled={busy} onClick={()=>void load(cursor)} className="rounded border p-3">Load more</button>}
      {order&&<section className="space-y-3 rounded-xl border p-5" aria-label="Plaque request details">
        <h2 className="text-xl font-semibold">{order.reference} · {labels[order.status]}</h2>
        <p>Registered property: {order.address||'Fulfilment details required'}</p>
        {order.blockedReason&&<p role="alert">{order.blockedReason}</p>}
        <p>{order.notes}</p><ul>{order.items.map(item=><li key={item.areaId}>{item.roomLabel} · {item.kind==='FIRST_ISSUE'?'First plaque':'Replacement copy'}{item.roomLabel!==item.roomLabelSnapshot?' · Room renamed since request':''}{!item.areaActive?' · Room no longer active':''}</li>)}</ul>
        <div className="flex flex-wrap gap-3">
          {order.status==='REQUESTED'&&<><button disabled={busy||!!order.blockedReason} onClick={()=>void transition('START_PRODUCTION')} className="rounded border p-3">Start production</button><button disabled={busy} onClick={()=>void transition('CANCEL')} className="rounded border p-3">Cancel request</button></>}
          {order.status==='IN_PRODUCTION'&&<button disabled={busy||!!order.blockedReason} onClick={()=>void transition('DISPATCH')} className="rounded border p-3">Mark dispatched</button>}
          {order.status==='DISPATCHED'&&<button disabled={busy||!!order.blockedReason} onClick={()=>void transition('COMPLETE')} className="rounded border p-3">Mark completed</button>}
          {['IN_PRODUCTION','DISPATCHED','COMPLETED'].includes(order.status)&&<button disabled={busy||!!order.blockedReason} onClick={()=>void preparePrint()} className="rounded border p-3">Prepare plaque sheet</button>}
        </div>
      </section>}
      {!!plaques.length&&<div className="flex gap-3"><button onClick={()=>{printing.current=true;window.print();}} className="rounded border p-3">Print plaque sheet</button><button onClick={()=>setPlaques([])} className="rounded border p-3">Close plaque sheet</button></div>}
    </section>
    <section className="plaque-sheet" aria-label="Printable room plaques">{plaques.map(plaque=><article className="plaque" key={plaque.areaId}>
      <p>Dinodia Smart Living</p><h2>{plaque.roomLabel}</h2>
      {/* A local, authenticated PNG is required to preserve QR module sharpness. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={plaque.image} alt={`Room access QR for ${plaque.roomLabel}`} width={320} height={320}/>
      <p>Scan to request access to this room.</p><p>Homeowner approval is required.</p><small>{order?.reference} · generation {plaque.generation}</small>
    </article>)}</section>
    <style>{`.plaque-sheet{display:flex;flex-wrap:wrap;gap:24px;margin-top:24px}.plaque{background:white;color:black;text-align:center;border:1px solid #777;padding:20px;break-inside:avoid;max-width:100%}.plaque h2{font-size:20px;font-weight:600}.plaque img{width:160px;height:160px;max-width:100%;image-rendering:pixelated;margin:auto}.plaque p{margin:6px 0}@media print{body *{visibility:hidden}.plaque-sheet,.plaque-sheet *{visibility:visible}.plaque-sheet{position:absolute;left:0;top:0;margin:0;gap:8mm}.plaque{width:75mm;padding:5mm}.plaque img{width:40mm;height:40mm}.plaque-controls{display:none!important}}`}</style>
  </>;
}
