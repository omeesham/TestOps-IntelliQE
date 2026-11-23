/**
 * Unit tests for API-automation git-publish file assembly + provider routing.
 * Proves the API path assembles a clean deliverable AND routes Bitbucket/Azure
 * URLs to the right provider (the capability this feature adds).
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { assembleApiFiles } from './api-git-assemble.js';
import { parseRepoUrl } from '../services/git/git.types.js';

describe('assembleApiFiles', () => {
  it('places bare-name scripts under the scripts folder', () => {
    const files = assembleApiFiles({ scripts: [{ fileName: 'login.spec.ts', code: 'test()' }] });
    expect(files).toEqual([{ path: 'tests/api/login.spec.ts', content: 'test()' }]);
  });

  it('honours a custom scripts folder and a foldered file path', () => {
    const files = assembleApiFiles({
      scriptsPath: 'qa/api',
      scripts: [{ fileName: 'a.ts', code: '1' }],
      files: [{ path: 'helpers/client.ts', content: '2' }],
    });
    expect(files).toContainEqual({ path: 'qa/api/a.ts', content: '1' });
    expect(files).toContainEqual({ path: 'helpers/client.ts', content: '2' }); // foldered path kept
  });

  it('ships the catalogue and dedupes by path (last write wins)', () => {
    const files = assembleApiFiles({
      scripts: [{ fileName: 'x.ts', code: 'first' }, { fileName: 'x.ts', code: 'second' }],
      catalogue: '{"endpoints":[]}',
    });
    expect(files.find((f) => f.path === 'tests/api/x.ts')!.content).toBe('second');
    expect(files.find((f) => f.path === 'tests/api/api-catalogue.json')!.content).toBe('{"endpoints":[]}');
  });

  it('strips path traversal', () => {
    const files = assembleApiFiles({ files: [{ path: '../../etc/passwd', content: 'x' }] });
    expect(files[0].path).toBe('etc/passwd'); // ../ segments removed
  });

  it('returns nothing for an empty payload', () => {
    expect(assembleApiFiles({})).toEqual([]);
  });
});

describe('provider routing — the Bitbucket/Azure capability added to the API path', () => {
  it('routes a Bitbucket Cloud URL to the bitbucket provider', () => {
    expect(parseRepoUrl('https://bitbucket.org/team/repo').provider).toBe('bitbucket');
  });

  it('routes a Bitbucket Server/DC URL to bitbucket-server', () => {
    expect(parseRepoUrl('https://bitbucket.mycorp.com/scm/KEY/repo.git').provider).toBe('bitbucket-server');
  });

  it('routes an Azure DevOps URL to the azure provider', () => {
    const c = parseRepoUrl('https://dev.azure.com/org/project/_git/repo');
    expect(c.provider).toBe('azure');
    expect(c.project).toBe('project');
    expect(c.repo).toBe('repo');
  });

  it('still routes GitLab (incl. subgroups) and GitHub', () => {
    expect(parseRepoUrl('https://gitlab.com/group/sub/repo').provider).toBe('gitlab');
    expect(parseRepoUrl('https://github.com/owner/repo').provider).toBe('github');
  });
});
