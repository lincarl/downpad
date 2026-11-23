const UNITS_PER_NOTCH = 120;

function verticalWheelUnits(event: WheelEvent): number {
  const mode = event.deltaMode;
  const delta = event.deltaY;
  const reported = "wheelDeltaY" in event && typeof event.wheelDeltaY === "number" ? event.wheelDeltaY : 0;
  const units = Math.abs(reported);

  // Chromium reports wheel ticks independently of the system scroll distance.
  // A pinch also reports a full tick for each tiny movement. Windows' lowest
  // nonzero wheel setting scrolls about 33 pixels per notch.
  const pinchLike = mode === WheelEvent.DOM_DELTA_PIXEL && delta !== 0
    && units >= UNITS_PER_NOTCH && Math.abs(delta) < 30 * units / UNITS_PER_NOTCH;
  if (units && !pinchLike && (mode === WheelEvent.DOM_DELTA_PIXEL || units >= UNITS_PER_NOTCH)) {
    return (Math.sign(delta) || -Math.sign(reported)) * units;
  }
  if (mode === WheelEvent.DOM_DELTA_PAGE) return delta * UNITS_PER_NOTCH;
  if (mode === WheelEvent.DOM_DELTA_LINE) return delta * UNITS_PER_NOTCH / 3;
  return delta;
}

export function installDocumentWheelZoom(panel: HTMLElement, documentVisible: () => boolean, zoom: (steps: number) => void) {
  let pending = 0;
  let previousTime = 0;
  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || !documentVisible()) {
      pending = 0;
      return;
    }
    const distance = verticalWheelUnits(event);
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
