import { createContext, useContext, type ReactNode } from "react";
import type { AppRuntime } from "./AppRuntime";

const AppRuntimeContext = createContext<AppRuntime | null>(null);

export function AppRuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime | null;
  children: ReactNode;
}) {
  return <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>;
}

export function useAppRuntime(): AppRuntime | null {
  return useContext(AppRuntimeContext);
}
