/**
 * Mobile drawer swipe gesture — the decision half. The App shell wires window
 * `touchstart`/`touchmove` into `decideDrawerSwipe` so the session rail's
 * slide-over drawer opens with a left-edge right-swipe and closes with a
 * left-swipe (hamburger / scrim tap / Esc / entry select stay). Pure and DOM
 * free; the wiring treats a horizontal INTENT first so rails of vertical
 * scroll never trip it, and only ever fires once per gesture.
 *
 * The open gesture is edge-ZONED on purpose: a mid-screen right-swipe is how
 * you back-scroll a chat, so only a drag starting within
 * `DRAWER_EDGE_ZONE_PX` of the left edge counts. iOS Safari may still claim
 * the system back gesture for the very first edge pixels — the hamburger
 * button remains the guaranteed path there.
 */

/** A right-swipe opens the drawer only when it starts within this left-edge zone. */
export const DRAWER_EDGE_ZONE_PX = 28;

/** |dx| needed before a gesture with horizontal intent actually flips the drawer. */
export const DRAWER_SWIPE_TRIGGER_PX = 56;

/** |dx| (and 1.2× dominance over |dy|) needed to treat a touch as horizontal at all. */
export const DRAWER_SWIPE_INTENT_PX = 12;

export type DrawerSwipeAction = 'open' | 'close' | null;

export function decideDrawerSwipe(input: {
  startX: number;
  dx: number;
  dy: number;
  drawerOpen: boolean;
}): DrawerSwipeAction {
  const dx = input.dx;
  const dy = input.dy;
  if (Math.abs(dx) < DRAWER_SWIPE_INTENT_PX || Math.abs(dx) < Math.abs(dy) * 1.2) {
    return null;
  }
  if (!input.drawerOpen) {
    return input.startX <= DRAWER_EDGE_ZONE_PX && dx >= DRAWER_SWIPE_TRIGGER_PX ? 'open' : null;
  }
  return dx <= -DRAWER_SWIPE_TRIGGER_PX ? 'close' : null;
}
