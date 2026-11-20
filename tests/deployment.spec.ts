import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, repositoriesOf, repositoryAliasesOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('configured repositories', () => {
  it('reads the rows in order, ignoring the legacy field when a row names a repository', () => {
    expect(repositoriesOf({ repositories: [{ repository: 'acme/gizmos' }, { repository: '' }, { repository: 'acme/widgets' }], repository: 'acme/legacy', cli: 'gh', pollSeconds: 60 }))
      .toEqual(['acme/gizmos', 'acme/widgets'])
  })
  it('folds the legacy field when no row names a repository', () => {
    expect(repositoriesOf({ repository: 'acme/legacy' })).toEqual(['acme/legacy'])
    expect(repositoriesOf({ repositories: [{ repository: '' }, {}], repository: 'acme/legacy' })).toEqual(['acme/legacy'])
  })
  it('keeps the first of names that differ only by case', () => {
    expect(repositoriesOf({ repositories: [{ repository: 'Acme/Widgets' }, { repository: 'acme/gizmos' }, { repository: 'ACME/widgets' }] })).toEqual(['Acme/Widgets', 'acme/gizmos'])
  })
  it('reads malformed configuration without throwing, keeping a legacy owner/name', () => {
    for (const config of [undefined, null, 'acme/widgets', {}, { repository: 'not a name' }, { repositories: 'acme/widgets' }, { repositories: [{ repository: 'acme/widgets', extra: 1 }] }])
      expect(repositoriesOf(config)).toEqual([])
    expect(repositoriesOf({ repositories: [{ repository: 'no name' }], repository: ' acme/legacy ' })).toEqual(['acme/legacy'])
  })
})

describe('repository aliases', () => {
  it('splits each row\'s aliases on commas and whitespace, in configured order', () => {
    expect(repositoryAliasesOf({ repositories: [{ repository: 'TGR-Robotics/A2_HMI', aliases: 'hmi' }, { repository: 'acme/widgets' },
      { repository: 'TGR-Robotics/epic_robot', aliases: 'robot, ros,,bot  arm' }] })).toEqual([
      { alias: 'hmi', repository: 'TGR-Robotics/A2_HMI' }, { alias: 'robot', repository: 'TGR-Robotics/epic_robot' },
      { alias: 'ros', repository: 'TGR-Robotics/epic_robot' }, { alias: 'bot', repository: 'TGR-Robotics/epic_robot' },
      { alias: 'arm', repository: 'TGR-Robotics/epic_robot' }])
  })
  it('drops the aliases of a row that names no repository', () => {
    expect(repositoryAliasesOf({ repositories: [{ repository: '', aliases: 'orphan' }, { repository: 'acme/widgets', aliases: 'w' }] }))
      .toEqual([{ alias: 'w', repository: 'acme/widgets' }])
  })
  it('reads malformed configuration without throwing, as no aliases', () => {
    for (const config of [undefined, null, 'hmi', { repositories: 'acme/widgets' }, { repositories: [{ repository: 'acme/widgets', aliases: 3 }] },
      { repositories: [{ repository: 'acme/widgets', aliases: 'w', extra: 1 }] }]) expect(repositoryAliasesOf(config)).toEqual([])
  })
})

describe('setup', () => {
  /** Fake gh CLI with push access to acme/widgets (also reached by its former name acme/gadgets) and the given access to acme/gizmos; other repositories are unreadable. */
  const many = (gizmosPush: boolean): string => program(join(dir, 'bin', 'gh-many'), `case "$*" in
  "api user") echo '{"login":"Agent-Bot","id":7}' ;;
  "api repos/acme/widgets --jq "*|"api repos/acme/gadgets --jq "*) echo '{"name":"acme/widgets","push":true}' ;;
  "api repos/ACME/Gizmos --jq "*) echo '{"name":"acme/gizmos","push":${gizmosPush}}' ;;
  *) echo 'HTTP 404' >&2; exit 1 ;;
esac`)
  const rows = (...names: string[]) => names.map(repository => ({ repository }))
  it('resolves every configured repository to its canonical name, in configured order, the first being the default', async () => {
    const deployment = await resolveDeployment(machine(), { repositories: rows('ACME/Gizmos', 'acme/widgets', 'acme/gadgets'), cli: many(true) }, probe, path)
    // acme/gadgets is a former name of acme/widgets, so it resolves to a repository already listed.
    expect(deployment).toMatchObject({ repository: 'acme/gizmos', repositories: ['acme/gizmos', 'acme/widgets'] })
  })
  it('maps each lowercased alias to the canonical name of its row\'s repository, the first row winning', async () => {
    const deployment = await resolveDeployment(machine(), { repositories: [{ repository: 'ACME/Gizmos', aliases: 'GZ, shared' },
      { repository: 'acme/gadgets', aliases: 'old shared' }, { repository: 'acme/widgets', aliases: 'constructor' }], cli: many(true) }, probe, path)
    // acme/gadgets was renamed acme/widgets, so its alias names the current name.
    expect(deployment.aliases).toEqual({ gz: 'acme/gizmos', shared: 'acme/gizmos', old: 'acme/widgets', constructor: 'acme/widgets' })
    // Setup is all-or-nothing: a repository that fails its probe leaves no deployment, so its aliases reach no map.
    await expect(resolveDeployment(machine(), { repositories: [{ repository: 'acme/widgets', aliases: 'w' }, { repository: 'acme/missing', aliases: 'm' }],
      cli: many(true) }, probe, path)).rejects.toEqual(setupError('github', 'repositoryUnreadable', { repository: 'acme/missing' }))
  })
  it('fails setup naming the configured repository the account cannot push to or read', async () => {
    await expect(resolveDeployment(machine(), { repositories: rows('acme/widgets', 'ACME/Gizmos'), cli: many(false) }, probe, path))
      .rejects.toEqual(setupError('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/gizmos' }))
    await expect(resolveDeployment(machine(), { repositories: rows('acme/widgets', 'acme/missing'), cli: many(true) }, probe, path))
      .rejects.toEqual(setupError('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/missing', output: expect.stringContaining('HTTP 404') }))
  })
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', repositories: ['acme/widgets'], github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
