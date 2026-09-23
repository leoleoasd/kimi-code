import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { detectBinary, guessMime } from '#/_base/utils/fileMeta';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime } from '#/runtime/runtime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { DeliverFileInputSchema, IDeliverFileTool, type DeliverFileInput } from './deliver-file';
import DESCRIPTION from './deliver-file.md?raw';

export const MAX_DELIVER_FILE_BYTES = 100 * 1024 * 1024;

export class DeliverFileTool implements IDeliverFileTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'DeliverFile' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DeliverFileInputSchema);

  constructor(
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {}

  private workspaceConfig(runtime: Runtime): WorkspaceConfig {
    const view = new RuntimeWorkspaceView(runtime, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: this.workspaceCtx.additionalDirs,
    });
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: DeliverFileInput): ToolExecution {
    const inspected = inspectAgentRuntime(this.runtime);
    const env = inspected.environment;
    const workspace = this.workspaceConfig(inspected);
    const path = resolvePathAccessPath(args.path, {
      env,
      workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Delivering ${args.path} to the user`,
      display: {
        kind: 'file_io',
        operation: 'read',
        path,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async () => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(args, path, lease.runtime, lease.runtime.fs!);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    args: DeliverFileInput,
    safePath: string,
    runtime: Runtime,
    fs: IHostFileSystem,
  ): Promise<ExecutableToolResult> {
    let stat;
    try {
      stat = await fs.stat(safePath);
    } catch {
      return { isError: true, output: `Cannot deliver "${args.path}": the file does not exist.` };
    }
    if (!stat.isFile) {
      return { isError: true, output: `Cannot deliver "${args.path}": not a regular file.` };
    }
    if (stat.size > MAX_DELIVER_FILE_BYTES) {
      return {
        isError: true,
        output: `Cannot deliver "${args.path}": ${stat.size} bytes exceeds the 100 MiB delivery limit.`,
      };
    }
    const data = await fs.readBytes(safePath);
    const name = args.name ?? runtime.path.basename(safePath);
    const mimeType = guessMime(name, detectBinary(data));
    const fileId = `f_${randomUUID()}`;
    const materialized = await this.mediaStore.materialize({
      fileId,
      size: data.byteLength,
      name,
      mimeType,
      stream: () => Readable.from(data),
    });
    if (materialized === undefined) {
      return { isError: true, output: `Failed to store "${args.path}" for delivery.` };
    }
    return {
      output: JSON.stringify({
        file_id: fileId,
        name,
        media_type: mimeType,
        size: data.byteLength,
      }),
    };
  }
}

registerAgentToolService(IDeliverFileTool, DeliverFileTool, {
  name: 'DeliverFile',
  domain: 'deliver',
  requiredRuntimeCapabilities: ['fs'],
});
