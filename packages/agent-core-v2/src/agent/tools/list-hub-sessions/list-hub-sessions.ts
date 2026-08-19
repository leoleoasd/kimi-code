
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
