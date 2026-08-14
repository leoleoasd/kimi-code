/**
 * Marker label mapping — markers render as a divider with a friendly label;
 * unknown keys fall back to the raw marker name as-is.
 */

import { describe, expect, it } from 'vitest';

import { markerLabel } from './markers';

describe('markerLabel', () => {
  it('maps known markers to friendly labels', () => {
    expect(markerLabel('undo')).toBe('conversation rolled back');
    expect(markerLabel('compact')).toBe('context compacted');
    expect(markerLabel('compaction')).toBe('context compacted');
  });

  it('falls back to the raw marker name as-is', () => {
    expect(markerLabel('goal')).toBe('goal');
    expect(markerLabel('plan.enter')).toBe('plan.enter');
    expect(markerLabel('custom:my-plugin')).toBe('custom:my-plugin');
  });
});
