/**
 * Drawer swipe decisions: open needs a left-EDGE right-swipe past the
 * trigger; close needs a left-swipe past the trigger from anywhere; vertical
 * (or short) drags never flip the drawer.
 * Run: `pnpm --filter @moonshot-ai/kimi-hub-web exec vitest run src/drawerGesture.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  decideDrawerSwipe,
  DRAWER_EDGE_ZONE_PX,
  DRAWER_SWIPE_TRIGGER_PX,
} from './drawerGesture';

describe('decideDrawerSwipe', () => {
  it('opens on a left-edge right-swipe past the trigger', () => {
    expect(
      decideDrawerSwipe({ startX: 12, dx: DRAWER_SWIPE_TRIGGER_PX, dy: 4, drawerOpen: false }),
    ).toBe('open');
  });

  it('ignores a right-swipe that starts away from the edge', () => {
    expect(
      decideDrawerSwipe({
        startX: DRAWER_EDGE_ZONE_PX + 40,
        dx: DRAWER_SWIPE_TRIGGER_PX + 40,
        dy: 0,
        drawerOpen: false,
      }),
    ).toBeNull();
  });

  it('ignores a right-swipe shorter than the trigger', () => {
    expect(
      decideDrawerSwipe({ startX: 0, dx: DRAWER_SWIPE_TRIGGER_PX - 10, dy: 0, drawerOpen: false }),
    ).toBeNull();
  });

  it('closes on a left-swipe while open, from anywhere', () => {
    expect(
      decideDrawerSwipe({ startX: 300, dx: -DRAWER_SWIPE_TRIGGER_PX, dy: -6, drawerOpen: true }),
    ).toBe('close');
  });

  it('treats mostly-vertical drags as scroll, not a drawer gesture', () => {
    expect(decideDrawerSwipe({ startX: 8, dx: 40, dy: 80, drawerOpen: false })).toBeNull();
    expect(decideDrawerSwipe({ startX: 8, dx: -60, dy: 90, drawerOpen: true })).toBeNull();
  });

  it('never opens when the drawer is already open, and never closes when closed', () => {
    expect(decideDrawerSwipe({ startX: 4, dx: 200, dy: 0, drawerOpen: true })).toBeNull();
    expect(decideDrawerSwipe({ startX: 200, dx: -200, dy: 0, drawerOpen: false })).toBeNull();
  });
});
