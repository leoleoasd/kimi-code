/**
 * `tools` domain — `IListHubSessionsTool` contract.
 *
 * Model-facing view of the kimi-hub roster: lists every agent connected to
 * the hub this process is attached to and the session ids each exposes, so
 * the model can pick a `SendHubMessage` target. Hub-gated — registered on an
 * agent only while the remote-control connection is up (the connector
 * registers it directly per agent, outside the static contribution fold).
 * Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { z } from 'zod';

import type { AgentTool } from '#/tool/toolContract';

export const ListHubSessionsToolInputSchema = z.object({}).strict();
export type ListHubSessionsToolInput = z.infer<typeof ListHubSessionsToolInputSchema>;

export interface IListHubSessionsTool extends AgentTool<ListHubSessionsToolInput> {
  readonly _serviceBrand: undefined;
}

export const IListHubSessionsTool: ServiceIdentifier<IListHubSessionsTool> =
  createDecorator<IListHubSessionsTool>('listHubSessionsTool');
