/**
 * Thinking-effort segment/default logic — a port of the TUI model selector's
 * rules; these cases mirror its documented behavior so the web popup and the
 * TUI dialog commit identical choices for the same model shape.
 */

import { describe, expect, it } from 'vitest';

import {
  commitDraftEffort,
  defaultThinkingEffortFor,
  draftEffortFor,
  segmentsFor,
  thinkingAvailability,
} from './thinking';

describe('thinkingAvailability', () => {
  it('classifies by capability strings', () => {
    expect(thinkingAvailability({ capabilities: ['always_thinking'] })).toBe('always-on');
    expect(thinkingAvailability({ capabilities: ['thinking'] })).toBe('toggle');
    expect(thinkingAvailability({ capabilities: ['vision'] })).toBe('unsupported');
    expect(thinkingAvailability({})).toBe('unsupported');
  });
});

describe('segmentsFor', () => {
  it('prepends off to declared efforts when the model can turn thinking off', () => {
    expect(
      segmentsFor({ capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'] }),
    ).toEqual(['off', 'low', 'high', 'max']);
  });

  it('omits off for always-on models', () => {
    expect(segmentsFor({ capabilities: ['always_thinking'], supportEfforts: ['low', 'high'] })).toEqual([
      'low',
      'high',
    ]);
    expect(segmentsFor({ capabilities: ['always_thinking'] })).toEqual(['on']);
  });

  it('falls back to the legacy on/off pair for boolean-thinking models', () => {
    expect(segmentsFor({ capabilities: ['thinking'] })).toEqual(['on', 'off']);
  });

  it('locks thinking-unsupported models to off', () => {
    expect(segmentsFor({})).toEqual(['off']);
  });
});

describe('defaultThinkingEffortFor', () => {
  it('prefers the declared default effort', () => {
    expect(
      defaultThinkingEffortFor({
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'low',
      }),
    ).toBe('low');
  });

  it('falls back to the middle effort', () => {
    expect(
      defaultThinkingEffortFor({ capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'] }),
    ).toBe('high');
  });

  it('is on for boolean models and off for unsupported ones', () => {
    expect(defaultThinkingEffortFor({ capabilities: ['thinking'] })).toBe('on');
    expect(defaultThinkingEffortFor({})).toBe('off');
  });
});

describe('commitDraftEffort', () => {
  const model = { capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'] };

  it('resolves the boolean on to the model default', () => {
    expect(commitDraftEffort(model, 'on')).toBe('high');
    expect(commitDraftEffort({ capabilities: ['thinking'] }, 'on')).toBe('on');
  });

  it('passes concrete efforts through', () => {
    expect(commitDraftEffort(model, 'max')).toBe('max');
    expect(commitDraftEffort(model, 'off')).toBe('off');
  });
});

describe('draftEffortFor', () => {
  const model = { capabilities: ['thinking'], supportEfforts: ['low', 'high'] };

  it('prioritizes the arrow-key override, then the live effort, then the default', () => {
    expect(draftEffortFor(model, { override: 'low', liveEffort: 'high' })).toBe('low');
    expect(draftEffortFor(model, { liveEffort: 'low' })).toBe('low');
    expect(draftEffortFor(model, {})).toBe('high');
  });

  it('coerces an effort the model cannot select onto the first segment', () => {
    expect(draftEffortFor(model, { liveEffort: 'max' })).toBe('off');
  });
});
