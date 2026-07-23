import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  resolveModelSelection,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind with Fable as Claude default', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_CLAUDE_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toEqual([
      'pa/claude-fable-5',
      'pa/claude-opus-4-6',
      'pa/claude-opus-4-7',
      'pa/claude-opus-4-8',
    ]);
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('pa/claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'pa/claude-opus-4-8')).toBe(
      'pa/claude-opus-4-8',
    );
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_CLAUDE_MODEL);
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_CLAUDE_MODEL);
    expect(normalizeModelSelection('codex', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, pinning Claude to Fable by default', () => {
    expect(resolveModelArg('claude', 'pa/claude-opus-4-7')).toBe('pa/claude-opus-4-7');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBe(DEFAULT_CLAUDE_MODEL);
    expect(resolveModelArg('claude', undefined)).toBe(DEFAULT_CLAUDE_MODEL);
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'pa/claude-opus-4-8')).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('resolves the concise Feishu fable alias only for Claude profiles', () => {
    expect(resolveModelSelection('claude', 'fable')).toBe(DEFAULT_CLAUDE_MODEL);
    expect(resolveModelSelection('claude', 'FABLE')).toBe(DEFAULT_CLAUDE_MODEL);
    expect(resolveModelSelection('claude', DEFAULT_CLAUDE_MODEL)).toBe(DEFAULT_CLAUDE_MODEL);
    expect(resolveModelSelection('codex', 'fable')).toBeUndefined();
    expect(resolveModelSelection('claude', 'unknown')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'pa/claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelLabel('claude', DEFAULT_MODEL)).toBe('Fable 5（默认）');
  });
});
