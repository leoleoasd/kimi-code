/**
 * Pending questions of the open session — polled every 2s while the session
 * is busy OR still has pending items, quiet when idle.
 *
 * Selection NEVER submits on click: options/multi-toggles/Skip only stage an
 * answer, and one bottom "Submit answers" button posts the whole request once
 * every question is staged. The wire contract resolves a request as a unit —
 * a partial answers map (the old click-to-submit single-select) would resolve
 * all sibling questions with no answer, silently swallowing them.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  answerQuestion,
  dismissQuestion,
  fetchPendingQuestions,
  type QuestionAnswer,
  type QuestionRequest,
} from '#/sessions/interactions';
import { ActionButton, ErrorLine } from './ui';

export function QuestionsCard({
  baseUrl,
  token,
  sessionId,
  /** Session busy flag — polling runs while busy even with zero items yet. */
  active,
}: {
  baseUrl: string;
  token: string;
  sessionId: string;
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['questions', baseUrl, sessionId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchPendingQuestions({ baseUrl, token, sessionId }),
    refetchInterval: (q) => (active || (q.state.data?.length ?? 0) > 0 ? 2000 : false),
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const items = query.data ?? [];
  if (items.length === 0) return null;

  const run = (fn: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    void fn()
      .then(() => queryClient.invalidateQueries({ queryKey }))
      .catch(setError)
      .finally(() => {
        setWorking(false);
      });
  };

  const answer = (questionId: string, answers: Record<string, QuestionAnswer>) => {
    run(() => answerQuestion({ baseUrl, token, sessionId, questionId, answers }));
  };
  const dismiss = (questionId: string) => {
    run(() => dismissQuestion({ baseUrl, token, sessionId, questionId }));
  };

  return (
    <div className="border-t border-sky-900/50 bg-sky-950/20 px-3 py-2">
      <div className="mb-1 text-[12px] font-medium text-sky-200">
        The agent has a question ({items.length})
      </div>
      {error !== null ? (
        <div className="mb-1">
          <ErrorLine error={error} />
        </div>
      ) : null}
      {items.map((request) => (
        <QuestionRequestView
          key={request.questionId}
          request={request}
          disabled={working}
          onAnswer={(answers) => {
            answer(request.questionId, answers);
          }}
          onDismiss={() => {
            dismiss(request.questionId);
          }}
        />
      ))}
    </div>
  );
}

function QuestionRequestView({
  request,
  disabled,
  onAnswer,
  onDismiss,
}: {
  request: QuestionRequest;
  disabled: boolean;
  onAnswer: (answers: Record<string, QuestionAnswer>) => void;
  onDismiss: () => void;
}) {
  /** Staged single/skip answers keyed by question id — posted only on submit. */
  const [staged, setStaged] = useState<Readonly<Record<string, QuestionAnswer>>>({});
  /** Multi-select toggles in flight, keyed by question id → option ids. */
  const [multi, setMulti] = useState<Readonly<Record<string, readonly string[]>>>({});

  const stageSingle = (questionId: string, optionId: string) => {
    setStaged((prev) => {
      const next = { ...prev };
      const cur = next[questionId];
      if (cur?.kind === 'single' && cur.option_id === optionId) delete next[questionId];
      else next[questionId] = { kind: 'single', option_id: optionId };
      return next;
    });
  };

  const stageSkip = (questionId: string) => {
    setStaged((prev) => {
      const next = { ...prev };
      if (next[questionId]?.kind === 'skipped') delete next[questionId];
      else next[questionId] = { kind: 'skipped' };
      return next;
    });
  };

  const toggleMulti = (questionId: string, optionId: string) => {
    setMulti((prev) => {
      const current = prev[questionId] ?? [];
      return {
        ...prev,
        [questionId]: current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      };
    });
    // Selecting an option cancels a staged skip for the same question.
    setStaged((prev) => {
      if (prev[questionId]?.kind !== 'skipped') return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  };

  const isAnswered = (q: QuestionRequest['questions'][number]): boolean =>
    staged[q.id] !== undefined || (q.multiSelect === true && (multi[q.id] ?? []).length > 0);
  const allAnswered = request.questions.every(isAnswered);

  const submit = () => {
    const answers: Record<string, QuestionAnswer> = { ...staged };
    for (const q of request.questions) {
      if (answers[q.id] === undefined && q.multiSelect === true) {
        answers[q.id] = { kind: 'multi', option_ids: multi[q.id] ?? [] };
      }
    }
    onAnswer(answers);
  };

  return (
    <div className="mb-2 rounded border border-neutral-800 bg-neutral-950/60 p-2">
      {request.questions.map((q) => {
        const stagedAnswer = staged[q.id];
        return (
        <div key={q.id} className="mb-1.5">
          {q.header !== undefined ? (
            <div className="text-[10px] text-neutral-500 uppercase">{q.header}</div>
          ) : null}
          <div className="mb-1 text-[12px] text-neutral-200">
            {q.question}
            {q.multiSelect ? <span className="text-neutral-500"> (multi)</span> : null}
          </div>
          <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:flex-wrap sm:items-center">
            {q.options.map((opt) =>
              q.multiSelect ? (
                <button
                  key={opt.id}
                  className={`min-h-[40px] rounded border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                    (multi[q.id] ?? []).includes(opt.id)
                      ? 'border-sky-600 bg-sky-900/50 text-sky-200'
                      : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                  }`}
                  title={opt.description}
                  disabled={disabled}
                  onClick={() => {
                    toggleMulti(q.id, opt.id);
                  }}
                >
                  {opt.label}
                </button>
              ) : (
                <button
                  key={opt.id}
                  className={`min-h-[40px] rounded border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                    stagedAnswer?.kind === 'single' && stagedAnswer.option_id === opt.id
                      ? 'border-sky-600 bg-sky-900/50 text-sky-200'
                      : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                  }`}
                  title={opt.description}
                  disabled={disabled}
                  onClick={() => {
                    stageSingle(q.id, opt.id);
                  }}
                >
                  {opt.label}
                </button>
              ),
            )}
            <ActionButton
              className="w-full sm:w-auto"
              disabled={disabled}
              title={
                staged[q.id]?.kind === 'skipped'
                  ? 'Staged as skipped — click to unstage'
                  : 'Stage this question as skipped, then submit'
              }
              onClick={() => {
                stageSkip(q.id);
              }}
            >
              {staged[q.id]?.kind === 'skipped' ? 'Skipped ✓' : 'Skip'}
            </ActionButton>
          </div>
        </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-neutral-600">{request.createdAt}</span>
        <div className="flex items-center gap-3">
          <button
            className="text-[10px] text-neutral-600 underline hover:text-neutral-400 disabled:opacity-40"
            disabled={disabled}
            onClick={onDismiss}
          >
            dismiss
          </button>
          <ActionButton disabled={disabled || !allAnswered} onClick={submit}>
            Submit answers
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
