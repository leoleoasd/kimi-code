import { useState } from 'react';

/** One choice in the goal-start permission confirmation. */
export interface GoalStartOption {
  readonly value: 'auto' | 'yolo' | 'manual' | 'cancel';
  readonly label: string;
  readonly description: string;
}

/**
 * The TUI's goal-start permission prompt, mirrored (`goal-start-permission-prompt.ts`):
 * manual asks auto/yolo/manual/cancel; yolo asks auto/keep-yolo/cancel. The page
 * plays the choose-then-start flow itself, protocol-native — no bridge line
 * means this card is ALSO what headless agents get (they host no TUI dialog).
 */
export function goalStartOptions(mode: 'manual' | 'yolo'): readonly GoalStartOption[] {
  const options: GoalStartOption[] = [
    {
      value: 'auto',
      label: 'Switch to Auto and start',
      description:
        'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
    },
  ];
  if (mode === 'manual') {
    options.push(
      {
        value: 'yolo',
        label: 'Switch to YOLO and start',
        description:
          'Tools and plan changes are approved automatically. Kimi Code may still ask you questions.',
      },
      {
        value: 'manual',
        label: 'Start in Manual',
        description:
          'Keep approvals on. Kimi Code will ask before risky actions, so the goal may stop and wait for you.',
      },
    );
  } else {
    options.push({
      value: 'yolo',
      label: 'Keep YOLO and start',
      description:
        'Tools and plan changes stay approved automatically. Kimi Code may still ask you questions.',
    });
  }
  return options;
}

export function GoalStartCard({
  mode,
  objective,
  busy,
  onChoice,
  onCancel,
}: {
  mode: 'manual' | 'yolo';
  objective: string;
  busy: boolean;
  onChoice: (choice: 'auto' | 'yolo' | 'manual') => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="border-t border-amber-900/60 bg-amber-950/20 px-3 py-2">
      <div className="mb-1 text-[12px] font-medium text-amber-200">
        {mode === 'yolo' ? 'Start a goal in YOLO mode?' : 'Start a goal with approvals on?'}
      </div>
      <div className="mb-2 line-clamp-2 text-[11px] break-all text-neutral-400" title={objective}>
        {objective}
      </div>
      {error !== null ? (
        <div className="mb-1 text-[11px] text-red-400">
          {error instanceof Error ? error.message : 'error'}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        {goalStartOptions(mode).map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={busy}
            className="rounded border border-neutral-700 bg-neutral-900/60 px-2.5 py-1.5 text-left hover:border-amber-700 disabled:opacity-50"
            onClick={() => {
              try {
                onChoice(option.value as 'auto' | 'yolo' | 'manual');
              } catch (choiceError: unknown) {
                setError(choiceError);
              }
            }}
          >
            <div className="text-[12px] text-neutral-100">{option.label}</div>
            <div className="text-[10px] text-neutral-500">{option.description}</div>
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          className="rounded px-2.5 py-1 text-left text-[11px] text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
          onClick={onCancel}
        >
          Do not start — return the command to the composer
        </button>
      </div>
    </div>
  );
}
