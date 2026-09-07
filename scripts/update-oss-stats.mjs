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
const VISIBLE_CONTRIBUTIONS = 3;

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

function groupByRepository(contributions) {
  const grouped = new Map();

  for (const contribution of contributions) {
    grouped.set(contribution.repository, [...(grouped.get(contribution.repository) ?? []), contribution]);
  }

  return [...grouped].sort(([, previous], [, next]) => next[0].openedAt.localeCompare(previous[0].openedAt));
}

function renderBadge(label, value) {
  const encodedLabel = encodeURIComponent(label);
  return `<img alt="${label} ${value}" src="https://img.shields.io/badge/${encodedLabel}-${value}-FC98A8?style=for-the-badge&labelColor=2B2B2B&logo=github&logoColor=FC98A8">`;
}

function renderEntry({ kind, title, url, openedAt }) {
  const icon = kind === 'pullRequest' ? '🔀' : '🐛';
  return `- ${icon} \`${openedAt}\` [${title}](${url})`;
}

function renderRepository(repository, contributions) {
  const recent = contributions.slice(0, VISIBLE_CONTRIBUTIONS);
  const older = contributions.slice(VISIBLE_CONTRIBUTIONS);

  const lines = [
    `**[${repository}](https://github.com/${repository})** <sub>${contributions.length}</sub>`,
    '',
    ...recent.map(renderEntry),
  ];

  if (older.length > 0) {
    lines.push(
      '',
      '<details>',
      `<summary>이전 기여 ${older.length}개 더 보기</summary>`,
      '',
      ...older.map(renderEntry),
      '',
      '</details>',
    );
  }

  return lines.join('\n');
}

function renderSection(contributions, mergedPullRequestCount, issueCount) {
  const repositories = groupByRepository(contributions);

  return [
    '<div align="center">',
    '',
    [
      renderBadge('Merged PRs', mergedPullRequestCount),
      renderBadge('Issues', issueCount),
      renderBadge('Repositories', repositories.length),
    ].join('\n'),
    '',
    '</div>',
    '',
    repositories.map(([repository, items]) => renderRepository(repository, items)).join('\n\n'),
  ].join('\n');
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

  const toContribution = kind => item => ({
    kind,
    repository: toRepositoryFullName(item),
    title: item.title,
    url: item.html_url,
    openedAt: toDate(item.created_at),
  });

  const mergedPullRequests = (await searchIssues(`type:pr author:${username} is:merged -user:${username}`))
    .map(toContribution('pullRequest'))
    .filter(({ repository }) => isAllowed(repository));

  const issues = (await searchIssues(`type:issue author:${username} -user:${username}`))
    .map(toContribution('issue'))
    .filter(({ repository }) => isAllowed(repository));

  const contributions = [...mergedPullRequests, ...issues].sort((previous, next) =>
    next.openedAt.localeCompare(previous.openedAt),
  );

  writeReadme(renderSection(contributions, mergedPullRequests.length, issues.length));

  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        mergedPullRequests: mergedPullRequests.length,
        issues: issues.length,
        repositories: groupByRepository(contributions).length,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`merged PR ${mergedPullRequests.length}개, 이슈 ${issues.length}개 반영`);
}

await main();
