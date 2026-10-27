"use client";

import {
  createContext,
  useContext,
  useMemo,
  useTransition,
  type ReactNode,
  type TransitionStartFunction,
} from "react";

type OverviewPending = {
  isPending: boolean;
  startTransition: TransitionStartFunction;
};

const OverviewPendingContext = createContext<OverviewPending | null>(null);

/**
 * Shares one transition between the filter bar (which navigates) and the
 * results (which stay on screen, marked as updating, until the RSC lands).
 */
export function OverviewPendingProvider({ children }: { children: ReactNode }) {
  const [isPending, startTransition] = useTransition();
  const value = useMemo(
    () => ({ isPending, startTransition }),
    [isPending, startTransition],
  );

  return (
    <OverviewPendingContext.Provider value={value}>
      {children}
    </OverviewPendingContext.Provider>
  );
}

/** The shared transition, or a local one when rendered outside the provider. */
export function useOverviewTransition(): [boolean, TransitionStartFunction] {
  const shared = useContext(OverviewPendingContext);
  const local = useTransition();

  return shared ? [shared.isPending, shared.startTransition] : local;
}

export function OverviewResults({ children }: { children: ReactNode }) {
  const isPending = useContext(OverviewPendingContext)?.isPending ?? false;

  return (
    <div
      className="overview-results"
      aria-busy={isPending ? "true" : undefined}
      data-updating={isPending ? "true" : undefined}
    >
      {children}
    </div>
  );
}
