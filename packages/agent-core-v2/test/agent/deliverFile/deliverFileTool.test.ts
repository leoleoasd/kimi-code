import * as posixPath from 'node:path/posix';

import { describe, expect, it, vi } from 'vitest';

import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';
import type { ISessionMediaStore, SessionMediaMaterializeInput } from '#/agent/media/sessionMediaStore';
import {
  DeliverFileTool,
  MAX_DELIVER_FILE_BYTES,
} from '#/agent/tools/deliver-file/deliverFileTool';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime } from '#/runtime/runtime';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const signal = new AbortController().signal;
const WORKSPACE = stubWorkspaceContext('/ws');

function createTestEnv(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  } as IHostEnvironment;
}

function buildTool(options: {
  stat?: ReturnType<typeof vi.fn>;
  readBytes?: ReturnType<typeof vi.fn>;
  materialize?: ReturnType<typeof vi.fn>;
}) {
  const stat =
    options.stat ?? vi.fn(async () => ({ isFile: true, isDirectory: false, size: 11 }));
  const readBytes = options.readBytes ?? vi.fn(async () => new TextEncoder().encode('hello world'));
  const fs = { stat, readBytes } as unknown as IHostFileSystem;
  const env = createTestEnv();
  const runtimeValue = {
    identity: { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
    capabilities: new Set(['fs'] as const),
    environment: env,
    path: posixPath,
    workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots },
    fs,
    status: 'ready',
    onDidChangeStatus: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as unknown as Runtime;
  const runtime: IAgentRuntimeService = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: () => true,
    inspect: () => runtimeValue,
    acquire: () => ({
      runtime: runtimeValue,
      track: (resource) => resource,
      dispose: () => {},
    }),
  };
  const materialize =
    options.materialize ?? vi.fn(async () => '/session-media/f_x/report.txt');
  const mediaStore = {
    _serviceBrand: undefined,
    materialize,
  } as unknown as ISessionMediaStore;
  return { tool: new DeliverFileTool(mediaStore, runtime, WORKSPACE), fs, materialize };
}

async function execute(tool: DeliverFileTool, args: { path: string; name?: string }): Promise<ExecutableToolResult> {
  const resolved: ToolExecution = tool.resolveExecution(args);
  if (!('execute' in resolved)) return resolved;
  return resolved.execute({ turnId: 0, toolCallId: 'call-1', signal });
}

describe('DeliverFileTool', () => {
  it('materializes the file into the session media store and returns the JSON handle', async () => {
    const { tool, materialize } = buildTool({});
    const result = await execute(tool, { path: '/ws/report.txt' });
    expect(result.isError).toBeUndefined();
    expect(typeof result.output).toBe('string');
    const payload = JSON.parse(result.output as string) as Record<string, unknown>;
    expect(payload['file_id']).toMatch(/^f_[A-Za-z0-9-]+$/);
    expect(payload['name']).toBe('report.txt');
    expect(payload['media_type']).toBe('text/plain');
    expect(payload['size']).toBe(11);
    expect(materialize).toHaveBeenCalledTimes(1);
    const input = materialize.mock.calls[0]?.[0] as SessionMediaMaterializeInput;
    expect(input.fileId).toBe(payload['file_id']);
    expect(input.name).toBe('report.txt');
    expect(input.mimeType).toBe('text/plain');
    expect(input.size).toBe(11);
    expect(typeof input.stream).toBe('function');
  });

  it('honors a custom display name', async () => {
    const { tool, materialize } = buildTool({});
    const result = await execute(tool, { path: '/ws/report.txt', name: 'q3-report.md' });
    const payload = JSON.parse(result.output as string) as Record<string, unknown>;
    expect(payload['name']).toBe('q3-report.md');
    expect(payload['media_type']).toBe('text/markdown');
    const input = materialize.mock.calls[0]?.[0] as SessionMediaMaterializeInput;
    expect(input.name).toBe('q3-report.md');
  });

  it('rejects a missing file', async () => {
    const { tool, materialize } = buildTool({
      stat: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    });
    const result = await execute(tool, { path: '/ws/nope.txt' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('rejects a directory', async () => {
    const { tool, materialize } = buildTool({
      stat: vi.fn(async () => ({ isFile: false, isDirectory: true, size: 0 })),
    });
    const result = await execute(tool, { path: '/ws/dir' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not a regular file');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('rejects files over the delivery limit', async () => {
    const { tool, materialize } = buildTool({
      stat: vi.fn(async () => ({
        isFile: true,
        isDirectory: false,
        size: MAX_DELIVER_FILE_BYTES + 1,
      })),
    });
    const result = await execute(tool, { path: '/ws/huge.bin' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('100 MiB');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('errors when the media store refuses the file', async () => {
    const { tool } = buildTool({ materialize: vi.fn(async () => undefined) });
    const result = await execute(tool, { path: '/ws/report.txt' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to store');
  });

  it('resolves workspace-relative paths against the workspace root', async () => {
    const { tool } = buildTool({});
    const execution = tool.resolveExecution({ path: 'report.txt' });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    expect(execution.display).toMatchObject({ kind: 'file_io', operation: 'read', path: '/ws/report.txt' });
  });
});
