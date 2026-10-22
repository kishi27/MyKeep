import { createContext, useContext, useLayoutEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

const UnsavedContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {});

// This provider stays mounted outside PinGate's Activity. Only a boolean is
// retained here; drafts and File objects stay in the hidden editor's memory.
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  useLayoutEffect(() => {
    if (!dirty) return;
    const confirmLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [dirty]);
  return <UnsavedContext.Provider value={setDirty}>{children}</UnsavedContext.Provider>;
}

export function useUnsavedChanges(dirty: boolean) {
  const report = useContext(UnsavedContext);
  useLayoutEffect(() => {
    report(dirty);
    // No cleanup reset: Activity tears down effects on PIN relock, but the
    // draft still exists. Save/discard reports false when the editor resumes.
  }, [dirty, report]);
}
