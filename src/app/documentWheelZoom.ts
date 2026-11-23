import { useEffect, useRef, type RefObject } from "react";

const UNITS_PER_NOTCH = 120;
const WINDOWS_PIXELS_PER_LINE = 100 / 3;
const MAC_PIXELS_PER_NOTCH = 40;

export function useMacWheelControlKey() {
  const held = useRef(false);
  useEffect(() => {
    if (!/Mac/.test(navigator.platform)) return;
    const listeners = new AbortController();
    const capture = { capture: true, signal: listeners.signal };
    const observe = (event: KeyboardEvent | PointerEvent) => { held.current = event.ctrlKey; };
    window.addEventListener("keydown", observe, capture);
    window.addEventListener("keyup", observe, capture);
    window.addEventListener("pointerover", observe, capture);
    window.addEventListener("pointermove", observe, capture);
    window.addEventListener("pointerdown", observe, capture);
    window.addEventListener("blur", () => { held.current = false; }, { signal: listeners.signal });
    return () => listeners.abort();
  }, []);
  return held;
}

function verticalWheelUnits(event: WheelEvent, controlHeld: boolean): number {
  const mode = event.deltaMode;
  const delta = event.deltaY;
  const reported = "wheelDeltaY" in event && typeof event.wheelDeltaY === "number" ? event.wheelDeltaY : 0;
  const units = Math.abs(reported);

  if (mode === WheelEvent.DOM_DELTA_PAGE) {
    // Chromium divides the native page count by the display scale when producing a DOM wheel event.
    const scale = /Chrome\//.test(navigator.userAgent) ? window.devicePixelRatio : 1;
    return Math.round(delta * scale * UNITS_PER_NOTCH);
  }
  if (mode === WheelEvent.DOM_DELTA_LINE) {
    return units >= UNITS_PER_NOTCH ? (Math.sign(delta) || -Math.sign(reported)) * units : delta * UNITS_PER_NOTCH / 3;
  }
  if (/Mac/.test(navigator.platform)) {
    // A macOS mouse reports unaccelerated ticks. Chromium also supplies a
    // full tick for each trackpad pinch update, without a Control keypress.
    if (controlHeld && units) return (Math.sign(delta) || -Math.sign(reported)) * units;
    return delta * UNITS_PER_NOTCH / MAC_PIXELS_PER_NOTCH;
  }
  if (!units || !/Win/.test(navigator.platform)) return delta;
  if (!delta) return -reported;

  // Windows applies a whole number of scroll lines per notch. Other pixel
  // input, including a pinch with a synthetic tick count, keeps its distance.
  const linesPerNotch = Math.abs(delta) * UNITS_PER_NOTCH / (WINDOWS_PIXELS_PER_LINE * units);
  const lines = Math.round(linesPerNotch);
  if (lines > 0 && Math.abs(linesPerNotch - lines) <= lines * 1e-6) return Math.sign(delta) * units;
  return delta;
}

export function installDocumentWheelZoom(
  panel: HTMLElement,
  documentVisible: () => boolean,
  macControlKey: RefObject<boolean>,
  zoom: (steps: number) => void,
) {
  let pending = 0;
  let previousTime = 0;
  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || !documentVisible()) {
      pending = 0;
      return;
    }
    const distance = verticalWheelUnits(event, macControlKey.current);
    if (!distance) return;
    event.preventDefault();
    if (event.timeStamp - previousTime > 250 || Math.sign(distance) !== Math.sign(pending)) pending = 0;
    previousTime = event.timeStamp;
    pending += distance;
    const steps = Math.trunc(pending / UNITS_PER_NOTCH);
    pending -= steps * UNITS_PER_NOTCH;
    if (steps) zoom(-steps);
  };
  panel.addEventListener("wheel", onWheel, { passive: false });
  return () => panel.removeEventListener("wheel", onWheel);
}
