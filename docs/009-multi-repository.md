# 009 Multiple repositories

This fork (`XiaLiChao82/dsh-superagent-multirepo`) lets one installation watch **several GitHub repositories of the same agent account**, so a Ticket started from any of them runs in that repository. It is a superset of [006 Deployment](006-deployment.md), which describes the single-repository installation this fork came from.

## Goal

- An `@` mention, Issue, pull request, comment, or CI event in any configured repository becomes a Trigger and a Ticket on its own Thread.
- The Ticket works in the repository that produced it: its Execution environment names it, its prepare command checks it out, and its replies and pull requests go back there.
- Feishu stays available: a Feishu message that names a configured repository routes its Ticket to that repository; otherwise the default repository applies.
- A single-repository installation keeps working unchanged: its configuration and stored data are migrated once, automatically.

Out of scope: several agent accounts (the account's notifications are one stream), per-repository prompts or Policy rules, and several instances on one account (they would race for the same notifications).

## Configuration

The GitHub Source takes a list instead of one repository:

- `repositories` — rows of `{ repository: "owner/name" }`, the only repository field in the panel.
- `repository` — the legacy single-repository text field. It is still accepted on read and folded into `repositories` on the next save; code that reads a stored configuration uses one helper, `repositoriesOf()` in `deployment.ts`.
- An empty list is the existing `repositoryUnset` setup problem.
- `SETUP_FIELDS.github` becomes `['repositories', 'repository', 'cli']` (the legacy field is kept there while it can still be stored), so changing the list asks for the usual restart.

The list order is meaningful: the first repository is the **default repository**.

## Deployment

- `Deployment.repositories: string[]` — the canonical `owner/name` names GitHub reports, in configured order, deduplicated case-insensitively (`sameName`).
- `Deployment.repository: string` — the default repository (`repositories[0]`). It is what links, notices, and messages that name no repository fall back to.
- `resolveDeployment` probes `repos/<name>` for every configured repository and fails setup naming the repository that failed: unreadable, unreported, or read-only. Setup is all-or-nothing, as before.

## Commands

`Commands` acts on exactly one repository; `commands.repository` is the repository of its API paths, still prefixed as `repos/<repository>/`.

- `commands.for(repository)` returns `Commands` for another configured repository (case-insensitive match; throws for one that is not configured).
- `withSignal` keeps the repository.
- Pollers and readers that span repositories keep one `Commands` per repository instead of reaching for `deployment.repository`.

## Thread identity

The repository is part of a GitHub Thread's native ID, so the same Issue number in two repositories stays two Threads:

- Issue or pull request Thread ID: `<owner>/<name>#<number>`; Thread key `github:<owner>/<name>#<number>`.
- Default-branch CI Thread ID: `ci:<owner>/<name>:<branch>`.
- `channel.thread` uses the same key, and `channel.address` gains `repository`.
- Every GitHub Trigger carries `meta.repository` (canonical); every GitHub Thread record carries `meta.repository`.
- Helpers in `github-trigger.ts`: `githubThreadId`, `githubThreadOf`, `branchCiThreadId`, `branchCiOf`.

## Polling

- **Notifications** stay one account-wide stream with one cursor (`KV.github.since`); a notification is processed only when `repository.full_name` is a configured repository.
- **Repository streams** (new Issues, pull requests, comments) are polled once per repository; the cursor is per repository: `KV.github.stream('<owner/name>:<stream>')`.
- **Default-branch CI** is polled once per repository; state `KV.github-branch-ci:<owner/name>`; Trigger IDs include the repository.
- **Retries** are keyed by Thread ID (`github-retry` maps `<owner>/<name>#<number>`), so two repositories cannot collide.
- **Per-Thread cursors and CI fingerprints** are keyed by Thread ID: `github-cursor:<thread-id>`, `github-ci:<thread-id>`.
- Polled pull requests of open Tickets and polled subscribed Threads resolve their repository from the Thread ref.
- The Source keeps one health entry; its detail names the failing repository where the failure has one.

## Execution environment and Feishu routing

`DSH_SUPERAGENT_GITHUB_REPOSITORY` is the **Ticket's** repository, not the deployment's default:

1. a GitHub Trigger: its `meta.repository`;
2. a Feishu Trigger: the repository the message text names, else the default repository;
3. no Trigger (the main Session): the default repository.

`repositoryFor(trigger, deployment, config)` in `sources/github.ts` is the single implementation, used by the Source's `environment.values` and by the panel.

`repositoryInText(text, repositories)` matches, in order: a whole `owner/name`, a `github.com` URL for a configured repository, then a bare repository name as a whole word (case-insensitive). The first match wins; no match returns `undefined`.

A new variable `DSH_SUPERAGENT_GITHUB_REPOSITORIES` lists every configured repository, comma separated.

## Panel

- Source settings: the `repositories` rows field replaces the `repository` text field.
- Deployment settings: the derived accounts section lists the repositories.
- Thread labels: `<owner>/<name>#<number> <title>`, and CI `<owner>/<name> CI on <branch>`.
- A Ticket's repository shows in its existing Execution environment table (`DSH_SUPERAGENT_GITHUB_REPOSITORY`).

## Migration (database schema 12)

A schema 11 database was single-repository. `migrateTo12` rewrites it once, in one transaction, using the repository named by the stored GitHub Source configuration:

- Settings: folded by the Source schema when the settings are next parsed and saved.
- Thread rows: `ref.id`, `key`, `meta.repository`, and `correlated` Thread keys.
- Thread keys embedded elsewhere: Trigger `threads[]` and `channel.thread`, Ticket `channels[]` and `follows[].thread`, Decision `threadKey`, and leftover Evaluation records.
- KV: `github-cursor:N`, `github-ci:N`, `github-retry` map keys, `github-stream:*`, `github-branch-ci`.
- Outbox rows: `channel.thread` and addresses that name a repository.

Data written by an older build afterwards is not expected: the upgrade is one way, and the older build refuses a newer schema, as before.

## Tests

- Deployment and configuration: legacy fold, canonical list, per-repository setup failures.
- Identity and routing: Thread IDs, `githubAddress`, notification filtering, Feishu `repositoryInText`, `repositoryFor`.
- Polling: streams, cursors, retries and CI per repository; one repository's failure reported without stopping the other.
- Migration: a schema 11 fixture with Threads, Triggers, Tickets, Decisions, KV and Outbox rows, migrated to schema 12.
- Panel: repositories rows field and thread labels.
