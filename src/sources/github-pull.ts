/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, githubThreadId, githubThreadOf, repositoryFor, SOURCE, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
/** A PR as `pulls/<number>` returns it, with the configured repository it was read from. */
export type Pull = z.infer<typeof PullSchema> & { repository: string; number: number }
export async function readPull(ctx: SourceContext, repository: string, number: number, signal?: AbortSignal): Promise<Pull> {
  const commands = ctx.commands.withSignal(signal).for(repository)
  return { ...await commands.api(PullSchema, `pulls/${number}`), repository: commands.repository, number }
}
/** A PR a ticket follows, named by its repository and number. */
export interface TicketPull { repository: string; number: number }
const pullRef = (thread: string): TicketPull | undefined =>
  thread.startsWith(`${SOURCE}:`) ? githubThreadOf(thread.slice(SOURCE.length + 1)) : undefined
const samePull = (a: TicketPull, b: TicketPull): boolean => a.number === b.number && sameName(a.repository, b.repository)
/** The PRs a ticket follows (only open ones when `open`), in the order it bound them. */
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): TicketPull[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullRef(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): TicketPull | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** True when the PR was opened by the agent account from a branch in the PR's own repository (not a fork). */
export const agentPull = (pr: { repository: string; user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github'>): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', pr.repository)
/** The repository a ticket works in, from the Trigger it started from. */
const ticketRepository = (ctx: SourceContext, ticket: Ticket): string => repositoryFor(ctx.triggers.get(ticket.origin.triggerId), ctx.deployment)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
    && sameName(repositoryFor(source, ctx.deployment), pr.repository)
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).some(followed => samePull(followed, pr)))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${githubThreadId(pr.repository, pr.number)}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket of the PR's repository on its branch unless that ticket already follows
 * another open PR (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  const thread = `${SOURCE}:${githubThreadId(pr.repository, pr.number)}`
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open()
      .filter(ticket => ticketBranch(ticket, pr.head.ref) && sameName(ticketRepository(ctx, ticket), pr.repository)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === thread && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(followed => samePull(followed, pr)))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.patch(thread, { repository: pr.repository })
  ctx.threads.describe(thread, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    const id = githubThreadId(pr.repository, pr.number)
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id }, own)
    ctx.threads.patch(`${SOURCE}:${id}`, { repository: pr.repository, number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).some(followed => samePull(followed, pr)))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: githubThreadId(pr.repository, pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English. A PR outside `repository`, the ticket's, is named with its repository.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullRef(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const pull = pullRef(follow.thread)!
  const { number } = pull
  const url = githubPage(pull.repository, number, true)
  const name = sameName(pull.repository, repository) ? `PR #${number}` : `PR ${githubThreadId(pull.repository, number)}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[${name}](${url}) 已合并。` : `[${name}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[${name}](${url}) has merged.` : `[${name}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
