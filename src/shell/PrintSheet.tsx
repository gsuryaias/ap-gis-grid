// A print-only page (Atlas 2.0 phase 5): while mounted, printing (the lens's Print button or ⌘P)
// prints THIS sheet instead of the app — a briefing laid out for paper, with fixed light colours.
// It is portalled to <body>; `body.has-print-sheet` arms the print CSS in index.css, so lenses
// without a sheet print as before.
import { useEffect } from "react";
import { createPortal } from "react-dom";

export function PrintSheet({ label, children }: { label: string; children: React.ReactNode }) {
  useEffect(() => {
    document.body.classList.add("has-print-sheet");
    return () => document.body.classList.remove("has-print-sheet");
  }, []);
  return createPortal(
    <article className="print-sheet" data-print={label}>
      {children}
    </article>,
    document.body,
  );
}

/** Open the browser's print dialog (prints the mounted sheet). */
export const printSheet = () => window.print();
