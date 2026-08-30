import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Store } from "@/state/store";
import type { AppState } from "@/state/types";

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ store, children }: { store: Store; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    (notify) => store.subscribe(() => notify()),
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
