/**
 * `/model` picker decision logic — headless: key planning only. The DOM side
 * is not covered (this package has no component-test harness).
 */

import { describe, expect, it } from 'vitest';

import { planPickerKey } from './ModelPicker';

describe('planPickerKey', () => {
  it('maps arrows/Enter/Escape to picker actions', () => {
    expect(planPickerKey({ key: 'ArrowDown' })).toEqual({ kind: 'move', delta: 1 });
    expect(planPickerKey({ key: 'ArrowUp' })).toEqual({ kind: 'move', delta: -1 });
    expect(planPickerKey({ key: 'ArrowRight' })).toEqual({ kind: 'effort', delta: 1 });
    expect(planPickerKey({ key: 'ArrowLeft' })).toEqual({ kind: 'effort', delta: -1 });
    expect(planPickerKey({ key: 'Enter' })).toEqual({ kind: 'apply' });
    expect(planPickerKey({ key: 'Escape' })).toEqual({ kind: 'close' });
  });

  it('ignores other keys and IME composition', () => {
    expect(planPickerKey({ key: 'a' })).toEqual({ kind: 'none' });
    expect(planPickerKey({ key: 'Tab' })).toEqual({ kind: 'none' });
    expect(planPickerKey({ key: 'Enter', isComposing: true })).toEqual({ kind: 'none' });
  });
});
