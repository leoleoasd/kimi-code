import { Container, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '../../constant/symbols';
import type { EngineQueuedPrompt, QueuedMessage } from '../../types';
import { currentTheme } from '#/tui/theme';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  /** Prompts waiting in the ENGINE-side FIFO (other surfaces — a hub web UI /
   *  remote-control client). Rendered as a muted block under our own queue. */
  readonly engineQueue?: readonly EngineQueuedPrompt[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

const ELLIPSIS = '…';

export class QueuePaneComponent extends Container {
  private readonly messages: readonly QueuedMessage[];
  private readonly engineQueue: readonly EngineQueuedPrompt[];
  private readonly hint: string | undefined;

  constructor(options: QueuePaneOptions) {
    super();
    this.messages = options.messages;
    this.engineQueue = options.engineQueue ?? [];

    if (options.messages.length > 0) {
      // Bash commands (`! …`) are not steerable, so only advertise Ctrl-S when
      // there is at least one plain-text or skill item steering would send.
      const hasSteerable = options.messages.some((m) => m.mode !== 'bash');
      const canSteer = options.canSteerImmediately && hasSteerable;
      this.hint =
        options.isCompacting && !options.isStreaming
          ? '  ↑ to edit · will send after compaction'
          : canSteer
            ? '  ↑ to edit · ctrl-s to steer immediately'
            : '  ↑ to edit · will send after current task';
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('accent', text);
    const shell = (text: string) => currentTheme.fg('shellMode', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    const lines: string[] = [currentTheme.fg('border', '─'.repeat(width))];

    for (const item of this.messages) {
      const singleLine = item.text.replaceAll(/\s+/g, ' ').trim();
      const prefix = `  ${SELECT_POINTER} `;
      if (item.mode === 'bash') {
        // Shell commands get a `$ ` prompt and the shell-mode hue so they read
        // as commands, not as plain text that would be sent to the model.
        const prompt = '$ ';
        const availableWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(prompt));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix) + shell(prompt + truncated));
      } else {
        const availableWidth = Math.max(1, width - visibleWidth(prefix));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix + truncated));
      }
    }

    // Engine-side FIFO (other surfaces): same row grammar as above but fully
    // muted — these are not editable/steerable from the ↑/ctrl-s shortcuts,
    // so they must read as a separate block.
    if (this.engineQueue.length > 0) {
      lines.push(muted(truncateToWidth('  engine queue →', width, ELLIPSIS)));
      for (const item of this.engineQueue) {
        const prefix = `  ${SELECT_POINTER} `;
        const availableWidth = Math.max(1, width - visibleWidth(prefix));
        const truncated = truncateToWidth(item.text, availableWidth, ELLIPSIS);
        lines.push(dim(prefix + truncated));
      }
    }

    if (this.hint !== undefined) {
      lines.push(dim(truncateToWidth(this.hint, width, ELLIPSIS)));
    }

    return lines;
  }
}
