"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type SessionState = "inactive" | "checking" | "active" | "unavailable" | "ended";

export default function PortalSessionStatus() {
  const pathname = usePathname();
  const [sessionState, setSessionState] = useState<SessionState>("inactive");
  const [deadlineMono, setDeadlineMono] = useState<number | null>(null);
  const [deadlineWall, setDeadlineWall] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!pathname.startsWith("/installer") && pathname !== "/company") {
      setSessionState("inactive");
      setDeadlineMono(null);
      setDeadlineWall(null);
      setSecondsRemaining(null);
      return;
    }
    let stopped = false;
    let inFlight = false;
    const refresh = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const requestStartedAt = performance.now();
      try {
        const response = await fetch("/api/company/auth/session", { credentials: "same-origin", cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (stopped) return;
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) setSessionState("ended");
          else setSessionState("unavailable");
          return;
        }
        const expiresAt = Date.parse(String(body.expiresAt || ""));
        const serverNow = Date.parse(String(body.serverNow || ""));
        if (!Number.isFinite(expiresAt) || !Number.isFinite(serverNow)) {
          setSessionState("unavailable");
          return;
        }
        const remainingMs = Math.max(0, expiresAt - serverNow - (performance.now() - requestStartedAt));
        setDeadlineMono(performance.now() + remainingMs);
        setDeadlineWall(new Date(expiresAt).toISOString());
        setSessionState("active");
      } catch {
        if (!stopped) setSessionState("unavailable");
      } finally { inFlight = false; }
    };
    setSessionState("checking");
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [pathname]);

  useEffect(() => {
    if (deadlineMono === null) return;
    const update = () => setSecondsRemaining(Math.max(0, Math.ceil((deadlineMono - performance.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [deadlineMono]);

  if (sessionState === "inactive") return null;
  const message = sessionState === "active"
    ? secondsRemaining === 0
      ? "Company Portal sign-in reached its absolute 24-hour deadline. Sign in again to continue."
      : `Company Portal sign-in ends at ${deadlineWall ? new Date(deadlineWall).toLocaleString() : "the server-issued deadline"}${secondsRemaining === null ? " (checking remaining time)" : ` · ${Math.floor(secondsRemaining / 3600)}h ${String(Math.floor((secondsRemaining % 3600) / 60)).padStart(2, "0")}m ${String(secondsRemaining % 60).padStart(2, "0")}s remaining`}. Activity does not extend it.`
    : sessionState === "unavailable"
      ? `Dinodia could not currently verify this Portal session. It has not been declared expired; keep this page open and retry when the connection recovers.${deadlineWall && secondsRemaining !== null ? ` Last server-reported deadline: ${new Date(deadlineWall).toLocaleString()} (${Math.floor(secondsRemaining / 3600)}h ${String(Math.floor((secondsRemaining % 3600) / 60)).padStart(2, "0")}m ${String(secondsRemaining % 60).padStart(2, "0")}s on that deadline).` : ""}`
      : sessionState === "ended"
        ? "This Company Portal session is expired or revoked. Sign in again to continue."
        : "Checking the Company Portal session deadline…";
  const tone = sessionState === "unavailable" || sessionState === "ended" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-white text-slate-700";
  return <div role="status" aria-live="polite" className={`mx-auto mt-3 w-full max-w-5xl rounded-lg border px-4 py-2 text-sm ${tone}`}>{message}</div>;
}
