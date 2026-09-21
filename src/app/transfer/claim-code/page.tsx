// Architecture: App Router surface src/app/transfer/claim-code/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
 'use client';

 import { useState } from 'react';

 export default function OwnerTransferClaimCodePage() {
  const [claimCode] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem('dinodia_owner_transfer_claim_code_v1') || '';
    } catch {
      return '';
    }
  });
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!claimCode) return;
     try {
       await navigator.clipboard.writeText(claimCode);
       setCopied(true);
       window.setTimeout(() => setCopied(false), 1500);
     } catch {
       // ignore (user can copy manually)
     }
   }

   return (
     <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 px-6">
       <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
         <h1 className="text-xl font-semibold">Owner transfer claim code</h1>
         <p className="mt-2 text-sm text-zinc-300">
           Copy this code and share it with the incoming homeowner. You may have been logged out because the transfer
           removes the outgoing homeowner account.
         </p>

         <div className="mt-5 rounded-xl bg-zinc-950 border border-zinc-800 p-4">
           <div className="text-xs text-zinc-400">Claim code</div>
           <div className="mt-2 font-mono text-lg tracking-wider break-all">
             {claimCode || 'No claim code found on this device.'}
           </div>
         </div>

         <div className="mt-5 flex gap-3">
           <button
             type="button"
             onClick={copy}
             disabled={!claimCode}
             className="rounded-lg bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50"
           >
             {copied ? 'Copied' : 'Copy code'}
           </button>
           <a
             href="/claim"
             className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
           >
             Go to claim page
           </a>
           <a
             href="/login"
             className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
           >
             Go to login
           </a>
         </div>
       </div>
     </div>
   );
 }
