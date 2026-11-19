import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type DeploymentInfo = { revision: string; appliedAt: string };

export async function readDeploymentInfo(releaseRoot = process.cwd()): Promise<DeploymentInfo | null> {
  try {
    const { revision, appliedAt } = JSON.parse(await readFile(join(releaseRoot, 'deployment-info.json'), 'utf8'));
    if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision) ||
        typeof appliedAt !== 'string' || new Date(appliedAt).toISOString() !== appliedAt) {
      return null;
    }
    return { revision, appliedAt };
  } catch {
    return null;
  }
}
