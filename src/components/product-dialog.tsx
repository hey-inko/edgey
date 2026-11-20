"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

// The approved product dialog, opened over the catalogue while the address is
// /blades/[slug]. Closing it goes back, so Back closes it too.
export function ProductDialog({ children }: { children: ReactNode }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        requestAnimationFrame(() => opener.focus({ preventScroll: true }));
      }
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="detail-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      onClose={() => router.back()}
    >
      <div className="dialog-wrap">
        <button className="x-close" aria-label="Close blade details" type="button" onClick={() => dialog.current?.close()}>
          ×
        </button>
        {children}
      </div>
    </dialog>
  );
}
