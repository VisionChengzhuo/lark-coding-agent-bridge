import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';
export const DEFAULT_CLAUDE_MODEL = 'pa/claude-fable-5';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models exposed by the Fable bridge. Use the provider's complete
 * ids: Claude's built-in short aliases can strip the `pa/` prefix and route to
 * a different or nonexistent model on an Anthropic-compatible gateway.
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_CLAUDE_MODEL, label: 'Fable 5（默认）' },
  { value: 'pa/claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'pa/claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'pa/claude-opus-4-8', label: 'Opus 4.8' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

/** True when the selection is unset or uses the generic default sentinel. */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Claude profiles pin an
 * unset or invalid selection to Fable; Codex profiles retain their generic
 * default sentinel.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) {
    return agentKind === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_MODEL;
  }
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : agentKind === 'claude'
      ? DEFAULT_CLAUDE_MODEL
      : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` for the
 * Codex default sentinel. Claude's default resolves to the complete Fable ID.
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}
