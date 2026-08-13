/**
 * The accessibility tree, flattened, so a model can say "tap Sign in" rather
 * than guessing pixels.
 *
 * `/helper/<udid>/ax` returns the **raw** tree from the native bridge, not the
 * normalized shape serve-sim's SSE streamer emits — that normalizer runs only
 * on the `/ax` stream path, which is a subscription rather than a question. So
 * the flattening lives here, mirroring upstream's rules: drop nodes whose frame
 * is the whole screen, and stop at a cap so a pathological tree cannot become
 * an unbounded response.
 *
 * Frames come back in accessibility **points**, and the root's frame is the
 * screen in the same units — so normalizing against it is exact, where dividing
 * by the pixel dimensions would be wrong by the device scale.
 */

export interface RawAxNode {
  AXUniqueId?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  role_description?: string | null;
  type?: string | null;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: RawAxNode[];
}

export interface AxElement {
  id: string;
  /** Tree position, e.g. `0.3.1`. Stable enough to disambiguate two same-named rows. */
  path: string;
  label: string;
  value: string;
  role: string;
  type: string;
  enabled: boolean;
  frame: { x: number; y: number; width: number; height: number };
}

export interface AxSnapshot {
  screen: { width: number; height: number };
  elements: AxElement[];
}

/** Upstream's own cap, so a pathological tree cannot become an endless walk. */
export const MAX_ELEMENTS = 500;

function sameFrame(a: AxElement["frame"], b: AxElement["frame"]): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

export function flatten(raw: unknown): AxSnapshot {
  const roots = Array.isArray(raw) ? (raw as RawAxNode[]) : [];
  const screenFrame = roots[0]?.frame ?? { x: 0, y: 0, width: 1, height: 1 };
  const elements: AxElement[] = [];

  const walk = (node: RawAxNode, path: string): void => {
    if (elements.length >= MAX_ELEMENTS) return;
    const frame = node.frame;
    // A node covering the whole screen is a container, not something to tap.
    if (frame !== undefined && !sameFrame(frame, screenFrame)) {
      elements.push({
        id: node.AXUniqueId ?? path,
        path,
        label: node.AXLabel ?? "",
        value: node.AXValue ?? "",
        role: node.role_description ?? "",
        type: node.type ?? "",
        enabled: node.enabled !== false,
        frame,
      });
    }
    const children = node.children ?? [];
    for (let i = 0; i < children.length && elements.length < MAX_ELEMENTS; i += 1) {
      walk(children[i]!, `${path}.${i}`);
    }
  };

  for (let i = 0; i < roots.length && elements.length < MAX_ELEMENTS; i += 1) {
    walk(roots[i]!, String(i));
  }

  return { screen: { width: screenFrame.width, height: screenFrame.height }, elements };
}

export interface Match {
  element: AxElement;
  /** Normalized 0–1, the centre of the element's frame. */
  point: { x: number; y: number };
}

/**
 * Find an element by label.
 *
 * Exact beats prefix beats substring, and a label is matched against both
 * `AXLabel` and `AXValue` — a text field's label is often empty while its value
 * is the placeholder a person would read. Disabled elements are matched last
 * rather than skipped, because "the button is there but greyed out" is a more
 * useful failure than "I could not find it".
 */
export function findByLabel(snapshot: AxSnapshot, label: string): Match | null {
  const wanted = label.trim().toLowerCase();
  if (wanted === "") return null;

  const score = (element: AxElement): number => {
    const candidates = [element.label, element.value]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== "");
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate === wanted) best = Math.min(best, 0);
      else if (candidate.startsWith(wanted)) best = Math.min(best, 1);
      else if (candidate.includes(wanted)) best = Math.min(best, 2);
    }
    return element.enabled ? best : best + 10;
  };

  let bestElement: AxElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const element of snapshot.elements) {
    const value = score(element);
    if (value < bestScore) {
      bestScore = value;
      bestElement = element;
    }
  }
  if (bestElement === null || !Number.isFinite(bestScore)) return null;

  return { element: bestElement, point: centreOf(snapshot, bestElement) };
}

export function centreOf(snapshot: AxSnapshot, element: AxElement): { x: number; y: number } {
  const width = snapshot.screen.width || 1;
  const height = snapshot.screen.height || 1;
  return {
    x: clamp01((element.frame.x + element.frame.width / 2) / width),
    y: clamp01((element.frame.y + element.frame.height / 2) / height),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * What to say when a label matches nothing.
 *
 * Naming a few things that *are* on screen turns a dead end into a next step —
 * a model that asked for "Sign In" and is told "Log in" is present will get it
 * right on the retry, where "not found" sends it to guess coordinates.
 */
export function describeMiss(snapshot: AxSnapshot, label: string): string {
  const visible = snapshot.elements
    .map((element) => element.label.trim() || element.value.trim())
    .filter((text) => text !== "")
    .slice(0, 8);
  if (visible.length === 0) {
    return `Nothing on screen is labelled "${label}", and the simulator reported no labelled elements at all.`;
  }
  return `Nothing on screen is labelled "${label}". Visible labels include: ${visible.join(", ")}.`;
}
