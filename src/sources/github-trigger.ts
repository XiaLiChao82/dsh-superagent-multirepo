/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'
/**
 * Native Thread ID of an Issue or PR, `<owner>/<name>#<number>` (Thread key `github:<owner>/<name>#<number>`): the repository is
 * part of it so equal numbers in two repositories stay two Threads.
 */
export const githubThreadId = (repository: string, number: number): string => `${repository}#${number}`
/** Parses `githubThreadId`'s `<owner>/<name>#<number>`; undefined for any other ID, such as a default-branch CI Thread's. */
export function githubThreadOf(id: string): { repository: string; number: number } | undefined {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(id)
  return match ? { repository: match[1]!, number: Number(match[2]) } : undefined
}
/** Native Thread ID of a repository's default-branch CI, `ci:<owner>/<name>:<branch>`. */
export const branchCiThreadId = (repository: string, branch: string): string => `ci:${repository}:${branch}`
/** Parses `branchCiThreadId`: the repository runs to the first `:` after `ci:`, and the branch, which may hold `:` and `/`, is the rest. */
export function branchCiOf(id: string): { repository: string; branch: string } | undefined {
  if (!id.startsWith('ci:')) return undefined
  const rest = id.slice('ci:'.length)
  const split = rest.indexOf(':')
  return split > 0 && split < rest.length - 1 ? { repository: rest.slice(0, split), branch: rest.slice(split + 1) } : undefined
}
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (repository: string, number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${githubThreadId(repository, number)}`,
    address: { repository, number: String(number), ...(url ? { url } : {}) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/**
 * Parses a web or API URL for an Issue, PR, or review comment, naming the repository as the URL writes it; returns undefined for
 * other URLs. Callers compare `repository` with the configured ones (`sameName`).
 */
export function githubAddress(url: string): { repository: string; number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match) return undefined
  return { repository: match[1]!, number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues',
    ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** Characters of an owner or a repository name. */
const NAME = 'A-Za-z0-9_.\\-'
/** Ends a whole `owner/name`, which a path inside it may follow: no name character next, though a sentence's closing period may be. */
const ENDS = `(?![A-Za-z0-9_\\-]|\\.[${NAME}])`
/** Ends a bare name, which is not part of a path either: no name character or `/` next, though a sentence's closing period may be. */
const ENDS_WORD = `(?![A-Za-z0-9_\\-/]|\\.[${NAME}/])`
/** A bare name or an alias as a whole word: next to no name character or `/`. */
const word = (name: string): string => `(?<![${NAME}/])${escapeRegExp(name)}${ENDS_WORD}`
/**
 * The configured repository `text` names, with its configured casing. Rules, in order, each taking the match nearest the
 * start of the text: a whole `owner/name`; a `github.com` URL of a repository; the bare name (the part after `/`) as a whole
 * word, next to no name character or `/`; an alias of `aliases` as a whole word, which names the repository it maps to. All
 * case-insensitive; undefined when none matches.
 */
export function repositoryInText(text: string, repositories: readonly string[], aliases: Readonly<Record<string, string>> = {}): string | undefined {
  const rules: [repository: string, pattern: string][][] = [
    repositories.map(repository => [repository, `(?<![${NAME}/])${escapeRegExp(repository)}${ENDS}`]),
    repositories.map(repository => [repository, `github\\.com/${escapeRegExp(repository)}${ENDS}`]),
    repositories.map(repository => [repository, word(repository.slice(repository.indexOf('/') + 1))]),
    Object.entries(aliases).map(([alias, repository]) => [repository, word(alias)]),
  ]
  for (const rule of rules) {
    const found = rule.map(([repository, pattern]) => ({ repository, at: new RegExp(pattern, 'i').exec(text)?.index ?? -1 }))
      .filter(item => item.at >= 0).sort((a, b) => a.at - b.at)[0]
    if (found) return found.repository
  }
  return undefined
}
/**
 * The repository a Ticket started by `trigger` works in: a GitHub Trigger's configured `meta.repository`; else the configured
 * repository the Trigger's text names (such as a Feishu message's), by name or by alias; else the default repository.
 */
export function repositoryFor(trigger: Trigger | undefined, deployment: Pick<Deployment, 'repository' | 'repositories' | 'aliases'>): string {
  const named = trigger?.source === SOURCE && typeof trigger.meta.repository === 'string' ? trigger.meta.repository : undefined
  const own = named === undefined ? undefined : deployment.repositories.find(repository => sameName(repository, named))
  return own ?? (trigger && repositoryInText(trigger.text, deployment.repositories, deployment.aliases)) ?? deployment.repository
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { repository: string; number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
// Trigger IDs and Thread IDs below include the repository, so equal Issue and PR numbers in two repositories stay distinct.
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? githubThreadId(ref.repository, ref.number), String(comment.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: githubThreadId(ref.repository, ref.number) }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.repository, ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { repository: ref.repository, number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/** Builds the trigger for a newly opened Issue's title and body in `repository`. */
export function issueTrigger(issue: Opened, repository: string, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', repository, String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: githubThreadId(repository, issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(repository, issue.number, issue.html_url), url: issue.html_url,
    meta: { repository, number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in a repository and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(pull: Opened, repository: string, agent: string): Trigger {
  return { ...issueTrigger(pull, repository, agent), meta: { repository, number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(repository: string, branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('github-ci', `${repository}:branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: branchCiThreadId(repository, branch) }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, url, meta: { repository, ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, repository: string, revision: number,
  summary: string): Trigger {
  return { id: key('github-ci', repository, String(pr.number), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: githubThreadId(repository, pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(repository, pr.number), url: pr.html_url,
    meta: { repository, number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
