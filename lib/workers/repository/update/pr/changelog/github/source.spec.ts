import * as httpMock from '~test/http-mock.ts';
import { partial } from '~test/util.ts';
import { GlobalConfig } from '../../../../../../config/global.ts';
import * as dockerVersioning from '../../../../../../modules/versioning/docker/index.ts';
import * as semverVersioning from '../../../../../../modules/versioning/semver/index.ts';
import * as packageCache from '../../../../../../util/cache/package/index.ts';
import * as githubGraphql from '../../../../../../util/github/graphql/index.ts';
import type { GithubTagItem } from '../../../../../../util/github/graphql/types.ts';
import * as hostRules from '../../../../../../util/host-rules.ts';
import type { Timestamp } from '../../../../../../util/timestamp.ts';
import type { BranchUpgradeConfig } from '../../../../../types.ts';
import { getChangeLogJSON } from '../index.ts';

vi.mock('../../../../../../modules/datasource/npm/index.ts');

const upgrade = partial<BranchUpgradeConfig>({
  manager: 'some-manager',
  branchName: '',
  packageName: 'renovate',
  versioning: semverVersioning.id,
  currentVersion: '1.0.0',
  newVersion: '3.0.0',
  sourceUrl: 'https://github.com/chalk/chalk',
  releases: [
    { version: '0.9.0' },
    { version: '1.0.0', gitRef: 'npm_1.0.0' },
    {
      version: '2.3.0',
      gitRef: 'npm_2.3.0',
      releaseTimestamp: '2017-10-24T03:20:46.238Z' as Timestamp,
    },
    { version: '2.2.2', gitRef: 'npm_2.2.2' },
    {
      version: '2.4.2',
      releaseTimestamp: '2017-12-24T03:20:46.238Z' as Timestamp,
    },
    { version: '2.5.2' },
  ],
});

function expectedChangeLog({
  baseUrl = 'https://github.com/',
  apiBaseUrl = 'https://api.github.com/',
  sourceUrl = 'https://github.com/chalk/chalk',
  packageName = 'renovate',
} = {}) {
  return {
    hasReleaseNotes: true,
    project: {
      apiBaseUrl,
      baseUrl,
      packageName,
      repository: 'chalk/chalk',
      sourceUrl,
      type: 'github',
    },
    versions: [
      { version: '2.5.2' },
      { version: '2.4.2' },
      { version: '2.3.0' },
      { version: '2.2.2' },
    ],
  };
}

describe('workers/repository/update/pr/changelog/github/source', () => {
  afterEach(() => {
    // FIXME: add missing http mocks
    httpMock.clear(false);
  });

  describe('getChangeLogJSON', () => {
    beforeEach(() => {
      hostRules.add({
        hostType: 'github',
        matchHost: 'https://api.github.com/',
        token: 'abc',
      });
    });

    it('returns null if @types', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          currentVersion: undefined,
        }),
      ).resolves.toBeNull();
    });

    it('returns null if no currentVersion', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: 'https://github.com/DefinitelyTyped/DefinitelyTyped',
        }),
      ).resolves.toBeNull();
    });

    it('returns null if currentVersion equals newVersion', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          currentVersion: '1.0.0',
          newVersion: '1.0.0',
        }),
      ).resolves.toBeNull();
    });

    it('skips invalid repos', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: 'https://github.com/about',
        }),
      ).resolves.toBeNull();
    });

    it('works without Github', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
        }),
      ).resolves.toMatchObject(expectedChangeLog());
    });

    it('uses GitHub tags', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
        }),
      ).resolves.toMatchObject(expectedChangeLog());
    });

    it('fetches releases newest to oldest', async () => {
      const packageCacheSetSpy = vi.spyOn(packageCache, 'set');

      await getChangeLogJSON({
        ...upgrade,
      });

      const fetchedPairs = packageCacheSetSpy.mock.calls
        .filter((call) => call[0] === 'changelog-github-release')
        .map((call) => {
          const [, , , prev, next] = call[1].split(':');
          return `${prev}->${next}`;
        });
      expect(fetchedPairs).toEqual([
        '2.4.2->2.5.2',
        '2.3.0->2.4.2',
        '2.2.2->2.3.0',
        '1.0.0->2.2.2',
      ]);
    });

    it('reuses a release that is already cached', async () => {
      const cached = {
        version: '2.5.2',
        date: '2021-01-01',
        changes: [],
        compare: {},
      };
      vi.spyOn(packageCache, 'get').mockResolvedValue(cached);

      const res = await getChangeLogJSON({ ...upgrade });

      expect(res?.versions?.[0]).toMatchObject({ version: '2.5.2' });
    });

    it('filters unnecessary warns', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          packageName: '@renovate/no',
        }),
      ).resolves.toMatchObject(
        expectedChangeLog({ packageName: '@renovate/no' }),
      );
    });

    it('supports node engines', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          depType: 'engines',
        }),
      ).resolves.toMatchObject(expectedChangeLog());
    });

    it('handles no sourceUrl', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: undefined,
        }),
      ).resolves.toBeNull();
    });

    it('handles invalid sourceUrl', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: 'http://example.com',
        }),
      ).resolves.toBeNull();
    });

    it('handles missing Github token', async () => {
      GlobalConfig.set({ githubTokenWarn: true });
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: 'https://github.com',
        }),
      ).resolves.toEqual({ error: 'MissingGithubToken' });
    });

    it('handles suppressed Github warnings', async () => {
      GlobalConfig.set({ githubTokenWarn: false });
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: 'https://github.com',
        }),
      ).resolves.toBeNull();
    });

    it('handles no releases', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          releases: [],
        }),
      ).resolves.toBeNull();
    });

    it('handles not enough releases', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          releases: [{ version: '0.9.0' }],
        }),
      ).resolves.toBeNull();
    });

    it('deduplicates releases which are equal for the versioning in use', async () => {
      await expect(
        getChangeLogJSON({
          ...upgrade,
          versioning: dockerVersioning.id,
          currentVersion: 'v2.2.2',
          newVersion: 'v2.5.2',
          releases: [
            { version: '2.2.2' },
            { version: '2.3.0' },
            { version: 'v2.3.0' },
            { version: '2.5.2' },
            { version: 'v2.5.2' },
          ],
        }),
      ).resolves.toMatchObject({
        versions: [{ version: 'v2.5.2' }, { version: 'v2.3.0' }],
      });
    });

    it('supports github enterprise and github.com changelog', async () => {
      hostRules.add({
        hostType: 'github',
        token: 'super_secret',
        matchHost: 'https://github-enterprise.example.com/',
      });
      await expect(
        getChangeLogJSON({
          ...upgrade,
        }),
      ).resolves.toMatchObject(expectedChangeLog());
    });

    it('supports github enterprise and github enterprise changelog', async () => {
      hostRules.add({
        hostType: 'github',
        matchHost: 'https://github-enterprise.example.com/',
        token: 'abc',
      });
      vi.stubEnv('GITHUB_ENDPOINT', '');
      await expect(
        getChangeLogJSON({
          ...upgrade,
          sourceUrl: 'https://github-enterprise.example.com/chalk/chalk',
        }),
      ).resolves.toMatchObject(
        expectedChangeLog({
          baseUrl: 'https://github-enterprise.example.com/',
          apiBaseUrl: 'https://github-enterprise.example.com/api/v3/',
          sourceUrl: 'https://github-enterprise.example.com/chalk/chalk',
        }),
      );
    });

    describe.each([false, true])(
      'comparison matching (reversed: %s)',
      (reversed) => {
        it.each`
          packageName        | depName  | prefixes                     | expectedPrefix
          ${'foo'}           | ${'bar'} | ${['v', 'release-', 'foo-']} | ${'foo-'}
          ${'other'}         | ${'foo'} | ${['v', 'release-', 'foo-']} | ${'foo-'}
          ${'foo'}           | ${'bar'} | ${['v']}                     | ${'v'}
          ${'foo'}           | ${'bar'} | ${['release-']}              | ${'release-'}
          ${'foo'}           | ${'bar'} | ${['foobar-', 'v']}          | ${'v'}
          ${'foo.js+[core]'} | ${'bar'} | ${['foo.js+[core]-', 'v']}   | ${'foo.js+[core]-'}
          ${'other'}         | ${'a+b'} | ${['a+b-', 'v']}             | ${'a+b-'}
          ${'foo.js'}        | ${'bar'} | ${['fooXjs-', 'v']}          | ${'v'}
          ${'other'}         | ${'a+b'} | ${['aaab-', 'v']}            | ${'v'}
          ${'foo'}           | ${'bar'} | ${['foo-v', 'foo-', 'v']}    | ${'foo-'}
          ${'foo'}           | ${'bar'} | ${['v', '']}                 | ${''}
        `(
          'uses $expectedPrefix for $packageName / $depName',
          async ({ packageName, depName, prefixes, expectedPrefix }) => {
            httpMock
              .scope('https://api.github.com')
              .get(/.*/)
              .reply(200, [])
              .persist();
            vi.spyOn(githubGraphql, 'queryReleases').mockResolvedValue([]);
            const tags: string[] = prefixes.flatMap((prefix: string) =>
              ['1.0.0', '1.0.1'].map((version) => `${prefix}${version}`),
            );
            tags.push('foo-1.0.10', 'foo-1.0.1-rc.1');
            vi.spyOn(githubGraphql, 'queryTags').mockResolvedValue(
              (reversed ? tags.toReversed() : tags).map((version) =>
                partial<GithubTagItem>({ version }),
              ),
            );

            const result = await getChangeLogJSON({
              ...upgrade,
              packageName,
              depName,
              currentVersion: '1.0.0',
              newVersion: '1.0.1',
              releases: [{ version: '1.0.0' }, { version: '1.0.1' }],
            });

            expect(result?.versions?.[0].compare.url).toBe(
              `https://github.com/chalk/chalk/compare/${expectedPrefix}1.0.0...${expectedPrefix}1.0.1`,
            );
          },
        );
      },
    );

    it.each`
      tags                                  | expected
      ${['foo-v7', 'foo-v7.0.0', 'v7.0.0']} | ${'foo-v7.0.0'}
      ${['foo-v7', 'v7.0.0']}               | ${'v7.0.0'}
      ${['foo-v7']}                         | ${'foo-v7'}
    `(
      'preserves floating tag precision with $tags',
      async ({ tags, expected }) => {
        httpMock
          .scope('https://api.github.com')
          .get(/.*/)
          .reply(200, [])
          .persist();
        vi.spyOn(githubGraphql, 'queryReleases').mockResolvedValue([]);
        vi.spyOn(githubGraphql, 'queryTags').mockResolvedValue(
          [...tags, 'foo-v7.0.1'].map((version) =>
            partial<GithubTagItem>({ version }),
          ),
        );

        const result = await getChangeLogJSON({
          ...upgrade,
          packageName: 'foo',
          versioning: 'github-actions',
          currentVersion: '7.0.0',
          newVersion: '7.0.1',
          releases: [{ version: '7.0.0' }, { version: '7.0.1' }],
        });

        expect(result?.versions?.[0].compare.url).toBe(
          `https://github.com/chalk/chalk/compare/${expected}...foo-v7.0.1`,
        );
      },
    );

    it('isolates comparison caches for different dependency names', async () => {
      httpMock
        .scope('https://api.github.com')
        .get(/.*/)
        .reply(200, [])
        .persist();
      vi.spyOn(githubGraphql, 'queryReleases').mockResolvedValue([]);
      vi.spyOn(githubGraphql, 'queryTags').mockResolvedValue(
        ['foo', 'bar'].flatMap((name) =>
          ['1.0.0', '1.0.1'].map((version) =>
            partial<GithubTagItem>({ version: `${name}-${version}` }),
          ),
        ),
      );
      const config = {
        ...upgrade,
        packageName: 'shared',
        currentVersion: '1.0.0',
        newVersion: '1.0.1',
        releases: [{ version: '1.0.0' }, { version: '1.0.1' }],
      };

      const cache = new Map<string, unknown>();
      vi.spyOn(packageCache, 'get').mockImplementation((namespace, key) =>
        Promise.resolve(cache.get(`${namespace}:${key}`)),
      );
      vi.spyOn(packageCache, 'set').mockImplementation(
        (namespace, key, value) => {
          if (namespace === 'changelog-github-release') {
            cache.set(`${namespace}:${key}`, value);
          }
          return Promise.resolve();
        },
      );

      const foo = await getChangeLogJSON({ ...config, depName: 'foo' });
      const bar = await getChangeLogJSON({ ...config, depName: 'bar' });

      expect(foo?.versions?.[0].compare.url).toBe(
        'https://github.com/chalk/chalk/compare/foo-1.0.0...foo-1.0.1',
      );
      expect(bar?.versions?.[0].compare.url).toBe(
        'https://github.com/chalk/chalk/compare/bar-1.0.0...bar-1.0.1',
      );
    });

    it.each([false, true])(
      'selects the gha-runner-scale-set chart release (reversed: %s)',
      async (reversed) => {
        httpMock
          .scope('https://api.github.com')
          .get(/.*/)
          .reply(200, [])
          .persist();
        const versions = ['0.9.1', '0.9.3'].flatMap((version) => [
          `v${version}`,
          `gha-runner-scale-set-${version}`,
        ]);
        const ordered = reversed ? versions.toReversed() : versions;
        vi.spyOn(githubGraphql, 'queryTags').mockResolvedValue(
          ordered.map((version) => partial<GithubTagItem>({ version })),
        );
        vi.spyOn(githubGraphql, 'queryReleases').mockResolvedValue(
          ordered.map((version, id) => ({
            id,
            version,
            releaseTimestamp: '2024-06-01' as Timestamp,
            url: `https://github.com/actions/actions-runner-controller/releases/tag/${version}`,
            name: version,
            description: version.startsWith('gha-')
              ? 'Helm chart release'
              : 'Unrelated repository release',
          })),
        );

        const result = await getChangeLogJSON({
          ...upgrade,
          packageName:
            'ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set',
          depName: 'gha-runner-scale-set',
          versioning: 'docker',
          sourceUrl: 'https://github.com/actions/actions-runner-controller',
          currentVersion: '0.9.1',
          newVersion: '0.9.3',
          releases: [{ version: '0.9.1' }, { version: '0.9.3' }],
        });

        expect(result?.versions).toMatchObject([
          {
            compare: {
              url: 'https://github.com/actions/actions-runner-controller/compare/gha-runner-scale-set-0.9.1...gha-runner-scale-set-0.9.3',
            },
            releaseNotes: {
              tag: 'gha-runner-scale-set-0.9.3',
              body: 'Helm chart release\n',
              url: 'https://github.com/actions/actions-runner-controller/releases/tag/gha-runner-scale-set-0.9.3',
            },
          },
        ]);
      },
    );

    it('works with same version releases but different prefix', async () => {
      const githubTagsMock = vi.spyOn(githubGraphql, 'queryTags');
      githubTagsMock.mockResolvedValue(
        partial<GithubTagItem>([
          { version: 'v1.0.1' },
          { version: '1.0.1' },
          { version: 'correctPrefix/target@1.0.1' },
          { version: 'wrongPrefix/target-1.0.1' },
          { version: 'v1.0.2' },
          { version: '1.0.2' },
          { version: 'correctPrefix/target-1.0.2' },
          { version: 'wrongPrefix/target@1.0.2' },
        ]),
      );

      const upgradeData = partial<BranchUpgradeConfig>({
        manager: 'some-manager',
        branchName: '',
        packageName: 'correctPrefix/target',
        versioning: 'npm',
        currentVersion: '1.0.0',
        newVersion: '1.0.2',
        sourceUrl: 'https://github.com/chalk/chalk',
        releases: [
          { version: '1.0.2', gitRef: '789012' },
          { version: '1.0.1', gitRef: '123456' },
          { version: '0.1.1', gitRef: 'npm_1.0.0' },
        ],
      });
      await expect(
        getChangeLogJSON({
          ...upgradeData,
        }),
      ).resolves.toMatchObject({
        project: {
          apiBaseUrl: 'https://api.github.com/',
          baseUrl: 'https://github.com/',
          depName: undefined,
          type: 'github',
          repository: 'chalk/chalk',
          sourceUrl: 'https://github.com/chalk/chalk',
          sourceDirectory: undefined,
          packageName: 'correctPrefix/target',
        },
        versions: [
          {
            version: '1.0.2',
            date: undefined,
            changes: [],
            compare: {
              url: 'https://github.com/chalk/chalk/compare/correctPrefix/target@1.0.1...correctPrefix/target-1.0.2',
            },
            releaseNotes: {
              url: 'https://github.com/chalk/chalk/compare/correctPrefix/target@1.0.1...correctPrefix/target-1.0.2',
              notesSourceUrl: '',
            },
          },
          {
            version: '1.0.1',
            date: undefined,
            changes: [],
            compare: {
              url: 'https://github.com/chalk/chalk/compare/npm_1.0.0...correctPrefix/target@1.0.1',
            },
            releaseNotes: {
              url: 'https://github.com/chalk/chalk/compare/npm_1.0.0...correctPrefix/target@1.0.1',
              notesSourceUrl: '',
            },
          },
        ],
        hasReleaseNotes: true,
      });
    });
  });
});
