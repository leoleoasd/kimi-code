import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DeliverFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('Absolute path, or a path relative to the workspace root, of the file to deliver.'),
    name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Display and download name the user sees. Defaults to the file basename.'),
  })
  .strict();

export type DeliverFileInput = z.infer<typeof DeliverFileInputSchema>;

export interface IDeliverFileTool extends AgentTool<DeliverFileInput> {
  readonly _serviceBrand: undefined;
}
export const IDeliverFileTool = createDecorator<IDeliverFileTool>('deliverFileTool');
