/**
 * Pending approvals of the open session — polled every 2s while the session
 * is busy OR still has pending items, quiet when idle. Approve / reject
 * resolve in place; the next poll settles the bar.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { fetchPendingApprovals, resolveApproval } from '#/sessions/interactions';
import { planReviewDisplayPlan } from './exit-plan-mode';
import { Markdown } from './Markdown';
import { ActionButton, ErrorLine, JsonView } from './ui';

export function ApprovalsBar({
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
  const queryKey = ['approvals', baseUrl, sessionId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchPendingApprovals({ baseUrl, token, sessionId }),
    refetchInterval: (q) => (active || (q.state.data?.length ?? 0) > 0 ? 2000 : false),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const items = query.data ?? [];
  if (items.length === 0) return null;

  const decide = async (approvalId: string, decision: 'approved' | 'rejected') => {
    setBusyId(approvalId);
    setError(null);
    try {
      await resolveApproval({ baseUrl, token, sessionId, approvalId, decision });
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      setError(error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="border-t border-amber-900/50 bg-amber-950/20 px-3 py-2">
      <div className="mb-1 text-[12px] font-medium text-amber-200">
        Waiting for your approval ({items.length})
      </div>
      {error !== null ? (
        <div className="mb-1">
          <ErrorLine error={error} />
        </div>
      ) : null}
      {items.map((item) => {
        const reviewPlan = planReviewDisplayPlan(item.toolInputDisplay);
        return (
          <div
            key={item.approvalId}
            className="mb-2 rounded border border-neutral-800 bg-neutral-950/60 p-2"
          >
            <div className="mb-1 text-[11px] text-neutral-300">
              <span className="text-neutral-500">tool </span>
              {item.toolName}
              <span className="text-neutral-500"> · </span>
              {item.action}
            </div>
            {reviewPlan !== undefined ? (
              <div className="max-h-72 overflow-y-auto pr-1">
                <Markdown text={reviewPlan} />
              </div>
            ) : item.toolInputDisplay !== undefined && item.toolInputDisplay !== null ? (
              <JsonView data={item.toolInputDisplay} />
            ) : null}
            <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
              <ActionButton
                className="w-full sm:w-auto"
                onClick={() => decide(item.approvalId, 'approved')}
                disabled={busyId !== null}
              >
                Approve
              </ActionButton>
              <ActionButton
                className="w-full sm:w-auto"
                danger
                onClick={() => decide(item.approvalId, 'rejected')}
                disabled={busyId !== null}
              >
                Reject
              </ActionButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}
