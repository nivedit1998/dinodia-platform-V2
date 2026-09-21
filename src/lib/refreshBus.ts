// Architecture: Shared platform helper src/lib/refreshBus.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
type RefreshListener = () => void;

const listeners = new Set<RefreshListener>();

export function subscribeToRefresh(listener: RefreshListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function triggerGlobalRefresh() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('Refresh listener failed', err);
    }
  });
}
