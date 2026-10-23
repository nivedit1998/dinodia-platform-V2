import RoomPlaqueRequestsClient from './RoomPlaqueRequestsClient';
export const dynamic='force-dynamic';
export default function RoomPlaqueRequestsPage() {
  return <main className="mx-auto min-h-screen max-w-5xl px-6 py-10">
    <p className="text-sm text-[var(--muted)]">Company Portal</p>
    <h1 className="mt-3 text-3xl font-semibold">Room plaque requests</h1>
    <p className="my-4">Review homeowner requests, prepare the current room codes and record physical fulfilment.</p>
    <RoomPlaqueRequestsClient />
  </main>;
}
