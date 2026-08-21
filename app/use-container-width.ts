/**
 * Layout decisions keyed to the panel, not the window.
 *
 * A nav panel is ~320-420px wide on a 1600px viewport, so any
 * `min-width` media query answers for the wrong box: the two-pane layout
 * used to engage because the *window* was wide and then squeeze its detail
 * pane to zero pixels inside the sidebar. One ResizeObserver on the panel's
 * root answers the question the layout is actually asking.
 */
import { useEffect, useRef, useState } from "react";

export function useContainerWide<T extends HTMLElement>(
  threshold: number,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setWide(width >= threshold);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, wide];
}
