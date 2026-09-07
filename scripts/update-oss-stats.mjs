import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = join(rootDirectory, 'README.md');
const blacklistPath = join(rootDirectory, 'config', 'blacklist.json');
const summaryPath = join(rootDirectory, 'config', 'summary.json');

const START_MARKER = '<!-- OSS:START -->';
const END_MARKER = '<!-- OSS:END -->';
const PER_PAGE = 100;
const MAX_PAGES = 5;

const username = process.env.GITHUB_USERNAME ?? 'tooth-is-silver';
const token = process.env.GITHUB_TOKEN;

async function searchIssues(query) {
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('https://api.github.com/search/issues');
    url.searchParams.set('q', query);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('advanced_search', 'true');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `${username}-profile-automation`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub 검색 실패 (${response.status}): ${await response.text()}`);
    }

    const { items: pageItems } = await response.json();
    items.push(...pageItems);

    if (pageItems.length < PER_PAGE) break;
  }

  return items;
}

function createBlacklistFilter() {
  const blacklist = JSON.parse(readFileSync(blacklistPath, 'utf8'));
  const organizations = new Set(blacklist.organizations.map(name => name.toLowerCase()));
  const repositories = new Set(blacklist.repositories.map(name => name.toLowerCase()));

  return repositoryFullName => {
    const [owner] = repositoryFullName.split('/');
    return !organizations.has(owner.toLowerCase()) && !repositories.has(repositoryFullName.toLowerCase());
  };
}

function toRepositoryFullName(item) {
  return item.repository_url.replace('https://api.github.com/repos/', '');
}

function toDate(isoString) {
  return isoString.slice(0, 10);
}

function escapeTableCell(text) {
  return text.replaceAll('|', '\\|');
}

function groupByRepository(contributions) {
  const grouped = new Map();

  for (const contribution of contributions) {
    const list = grouped.get(contribution.repository) ?? [];
    list.push(contribution);
    grouped.set(contribution.repository, list);
  }

  for (const list of grouped.values()) {
    list.sort((previous, next) => next.openedAt.localeCompare(previous.openedAt));
  }

  return [...grouped].sort(([, previous], [, next]) => next.length - previous.length);
}

function renderBadge(label, value, color) {
  const encodedLabel = encodeURIComponent(label);
  return `<img alt="${label}" src="https://img.shields.io/badge/${encodedLabel}-${value}-${color}?style=for-the-badge&logo=github">`;
}

function renderSection(mergedPullRequests, issues) {
  const repositoryCount = new Set(mergedPullRequests.map(({ repository }) => repository)).size;

  const lines = [
    '<div align="center">',
    '',
    [
      renderBadge('Merged PRs', mergedPullRequests.length, '2ea44f'),
      renderBadge('Issues', issues.length, 'd73a4a'),
      renderBadge('Repositories', repositoryCount, '0969da'),
    ].join('\n'),
    '',
    '</div>',
    '',
  ];

  for (const [repository, pullRequests] of groupByRepository(mergedPullRequests)) {
    lines.push(
      `### [${repository}](https://github.com/${repository})`,
      '',
      '| Pull Request | Opened |',
      '| --- | --- |',
      ...pullRequests.map(
        ({ title, url, openedAt }) => `| ✅ [${escapeTableCell(title)}](${url}) | \`${openedAt}\` |`,
      ),
      '',
    );
  }

  if (issues.length > 0) {
    lines.push(
      '### Reported issues',
      '',
      '| Issue | Repository | Opened |',
      '| --- | --- | --- |',
      ...issues.map(
        ({ title, url, repository, openedAt }) =>
          `| [${escapeTableCell(title)}](${url}) | [${repository}](https://github.com/${repository}) | \`${openedAt}\` |`,
      ),
      '',
    );
  }

  return lines.join('\n').trimEnd();
}

function writeReadme(section) {
  const readme = readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1) {
    throw new Error(`README.md에 ${START_MARKER} / ${END_MARKER} 마커가 필요합니다`);
  }

  const updated = `${readme.slice(0, start + START_MARKER.length)}\n\n${section}\n\n${readme.slice(end)}`;
  writeFileSync(readmePath, updated);
}

async function main() {
  const isAllowed = createBlacklistFilter();

  const toContribution = item => ({
    repository: toRepositoryFullName(item),
    title: item.title,
    url: item.html_url,
    openedAt: toDate(item.created_at),
  });

  const mergedPullRequests = (await searchIssues(`type:pr author:${username} is:merged -user:${username}`))
    .map(toContribution)
    .filter(({ repository }) => isAllowed(repository));

  const issues = (await searchIssues(`type:issue author:${username} -user:${username}`))
    .map(toContribution)
    .filter(({ repository }) => isAllowed(repository))
    .sort((previous, next) => next.openedAt.localeCompare(previous.openedAt));

  writeReadme(renderSection(mergedPullRequests, issues));

  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        mergedPullRequests: mergedPullRequests.length,
        issues: issues.length,
        repositories: new Set(mergedPullRequests.map(({ repository }) => repository)).size,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`merged PR ${mergedPullRequests.length}개, 이슈 ${issues.length}개 반영`);
}

await main();
