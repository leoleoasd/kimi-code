import { describe, expect, it } from 'vitest';

import { readHubFromOrigin } from './hubMessage';

describe('readHubFromOrigin', () => {
  it('reads the hub sender descriptor out of a user-turn origin payload', () => {
    expect(readHubFromOrigin({ kind: 'user', hubFrom: 'box (session session_1)' })).toBe(
      'box (session session_1)',
    );
  });

  it('ignores payloads without a hub tag (shell commands, plain user payloads, non-objects)', () => {
    expect(readHubFromOrigin({ kind: 'shell_command' })).toBeUndefined();
    expect(readHubFromOrigin({ kind: 'user' })).toBeUndefined();
    expect(readHubFromOrigin(undefined)).toBeUndefined();
    expect(readHubFromOrigin('x')).toBeUndefined();
    expect(readHubFromOrigin({ hubFrom: 42 })).toBeUndefined();
    expect(readHubFromOrigin({ hubFrom: '' })).toBeUndefined();
  });
});
