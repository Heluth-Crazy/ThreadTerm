import { beforeEach, describe, expect, it } from 'vitest';
import { localWorkspaceAuthority } from './localAuthority';

describe('localWorkspaceAuthority root identity', () => {
  beforeEach(() => localWorkspaceAuthority.reset());

  it('coalesces Windows drive aliases without replacing the operational root', async () => {
    const first = await localWorkspaceAuthority.ensure('D:\\Repo\\App\\');
    const alias = await localWorkspaceAuthority.ensure('\\\\?\\d:\\repo\\app');

    expect(alias.id).toBe(first.id);
    expect(first.canonicalRoot).toBe('D:/Repo/App');
    await expect(localWorkspaceAuthority.list()).resolves.toHaveLength(1);
  });

  it('coalesces ordinary and verbatim UNC aliases', async () => {
    const first = await localWorkspaceAuthority.ensure('\\\\server\\share\\Repo');
    const alias = await localWorkspaceAuthority.ensure('\\\\?\\UNC\\SERVER\\SHARE\\repo\\');

    expect(alias.id).toBe(first.id);
    await expect(localWorkspaceAuthority.list()).resolves.toHaveLength(1);
  });
});
