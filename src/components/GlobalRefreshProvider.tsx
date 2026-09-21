// Architecture: Reusable web UI component src/components/GlobalRefreshProvider.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useEffect } from 'react';
import { triggerGlobalRefresh } from '@/lib/refreshBus';

const INTERACTION_DEBOUNCE_MS = 400;
const INTERACTION_EVENTS: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'click'];

type Props = {
  children: React.ReactNode;
};

export function GlobalRefreshProvider({ children }: Props) {
  useEffect(() => {
    let lastInteraction = 0;

    const handleInteraction = () => {
      const now = Date.now();
      if (now - lastInteraction < INTERACTION_DEBOUNCE_MS) return;
      lastInteraction = now;
      triggerGlobalRefresh();
    };

    INTERACTION_EVENTS.forEach((event) => {
      window.addEventListener(event, handleInteraction, { passive: true });
    });

    // Kick off one refresh immediately in case components subscribe late
    triggerGlobalRefresh();

    return () => {
      INTERACTION_EVENTS.forEach((event) => {
        window.removeEventListener(event, handleInteraction);
      });
    };
  }, []);

  return <>{children}</>;
}
