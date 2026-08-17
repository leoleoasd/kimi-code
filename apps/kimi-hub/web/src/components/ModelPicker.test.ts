/**
 * `/model` popup decision logic — headless: open-state parsing, catalog
 * filtering, and key planning. The DOM side is not covered (this package has
 * no component-test harness).
 */

import { describe, expect, it } from 'vitest';

import type { ModelChoice } from '#/sessions/api';

import { filterModels, modelPickerQuery, planPickerKey } from './ModelPicker';

describe('modelPickerQuery', () => {
  it('opens on the bare word with an empty filter', () => {
    expect(modelPickerQuery('/model')).toEqual({ filter: '' });
  });

  it('treats the tail after the space as the filter', () => {
    expect(modelPickerQuery('/model k3')).toEqual({ filter: 'k3' });
    expect(modelPickerQuery('/model ')).toEqual({ filter: '' });
  });

  it('stays closed for anything else', () => {
    expect(modelPickerQuery('')).toBeNull();
    expect(modelPickerQuery('/mod')).toBeNull();
    expect(modelPickerQuery('/modelx')).toBeNull();
    expect(modelPickerQuery('/model/k3')).toBeNull();
    expect(modelPickerQuery('hello /model')).toBeNull();
  });
});

describe('filterModels', () => {
  const models: readonly ModelChoice[] = [
    { id: 'k3-gw', label: 'kimi-k3 (k3-gw · flashflame-gw)', provider: 'flashflame-gw' },
    { id: 'k3-b300', label: 'kimi-k3 (k3-b300 · b300)', provider: 'b300' },
    { id: 'my-tiny', label: 'my-tiny · selfhost', provider: 'selfhost' },
  ];

  it('returns the full catalog for an empty/blank filter', () => {
    expect(filterModels(models, '')).toEqual(models);
    expect(filterModels(models, '  ')).toEqual(models);
  });

  it('matches case-insensitively across alias, label, and provider', () => {
    expect(filterModels(models, 'B300').map((m) => m.id)).toEqual(['k3-b300']);
    expect(filterModels(models, 'kimi-k3').map((m) => m.id)).toEqual(['k3-gw', 'k3-b300']);
    expect(filterModels(models, 'selfhost').map((m) => m.id)).toEqual(['my-tiny']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterModels(models, 'nope')).toEqual([]);
  });
});

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
