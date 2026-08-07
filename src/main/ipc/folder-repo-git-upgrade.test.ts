import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import type { Repo } from '../../shared/types'

// Why: the watch must stay one stat per folder project per tick — counting the real
// calls is what keeps a directory-listing fan-out from creeping back in.
const { statCalls, readdirSpy } = vi.hoisted(() => ({
  statCalls: [] as string[],
  readdirSpy: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: (path: string, ...rest: never[]) => {
      statCalls.push(path)
      return actual.stat(path, ...rest)
    },
    readdir: (path: string, ...rest: never[]) => {
      readdirSpy(path)
      return actual.readdir(path, ...rest)
    }
  }
})

vi.mock('./worktree-remote', () => ({
  notifyWorktreesChanged: vi.fn()
}))
vi.mock('./worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))

import { notifyWorktreesChanged } from './worktree-remote'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { notifyMainWindowBecameVisible } from '../window/main-window-visibility'
import {
  startFolderRepoGitUpgradeWatch,
  stopFolderRepoGitUpgradeWatch
} from './folder-repo-git-upgrade'

type TestWindow = {
  destroyed: boolean
  visible: boolean
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}

function makeWindow(): TestWindow {
  const window: TestWindow = {
    destroyed: false,
    visible: true,
    isDestroyed: () => window.destroyed,
    isVisible: () => window.visible,
    isMinimized: () => false,
    webContents: { send: vi.fn() }
  }
  return window
}

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: '#000000',
    addedAt: Date.now(),
    kind: 'folder',
    ...overrides
  } as Repo
}

function makeStore(repos: Repo[]): {
  getRepos: () => Repo[]
  getRepo: ReturnType<typeof vi.fn>
  updateRepo: ReturnType<typeof vi.fn>
  getSettings: () => Record<string, never>
} {
  return {
    getRepos: () => repos,
    getRepo: vi.fn((id: string) => repos.find((repo) => repo.id === id)),
    updateRepo: vi.fn((id: string, updates: Partial<Repo>) => {
      const repo = repos.find((candidate) => candidate.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return repo
    }),
    getSettings: () => ({})
  }
}

const POLL_MS = 25
const IDLE_POLL_MS = 250

describe('folder repo git upgrade watch', () => {
  let root: string

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'folder-repo-upgrade-'))
    statCalls.length = 0
  })

  afterEach(async () => {
    stopFolderRepoGitUpgradeWatch()
    await rm(root, { recursive: true, force: true })
  })

  // Real timers: the tick awaits real filesystem stats, which fake timers cannot flush.
  async function tick(times = 1): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * times + POLL_MS))
  }

  it('upgrades a local folder repo once an external git init creates .git', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])
    const window = makeWindow()
    const onRepoUpgraded = vi.fn()

    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      onRepoUpgraded,
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()
    expect(store.updateRepo).not.toHaveBeenCalled()

    await mkdir(join(repoPath, '.git'))
    await tick()

    expect(store.updateRepo).toHaveBeenCalledWith('folder-repo', {
      kind: 'git',
      externalWorktreeVisibility: 'hide'
    })
    expect(prepareLocalWorktreeRootForRepo).toHaveBeenCalledTimes(1)
    expect(onRepoUpgraded).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith('repos:changed')
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(window, 'folder-repo')
  })

  it('upgrades only the folder repo that gained a .git marker', async () => {
    const pathA = join(root, 'project-a')
    const pathB = join(root, 'project-b')
    await mkdir(pathA)
    await mkdir(pathB)
    const store = makeStore([
      makeRepo({ id: 'repo-a', path: pathA }),
      makeRepo({ id: 'repo-b', path: pathB })
    ])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await mkdir(join(pathA, '.git'))
    await tick()

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).toHaveBeenCalledWith(
      'repo-a',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('never upgrades again once the repo is already git', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(3)

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  })

  it('skips remote and WSL folder repos a local stat cannot answer for', async () => {
    const sshPath = join(root, 'ssh-project')
    await mkdir(join(sshPath, '.git'), { recursive: true })
    const store = makeStore([
      makeRepo({ id: 'ssh-repo', path: sshPath, connectionId: 'conn-1' }),
      makeRepo({ id: 'wsl-repo', path: '\\\\wsl$\\Ubuntu\\home\\user\\project' }),
      makeRepo({ id: 'runtime-repo', path: sshPath, executionHostId: 'runtime:dev' })
    ])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(2)

    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('backs off to the idle interval and stats nothing when no folder project exists', async () => {
    const store = makeStore([makeRepo({ id: 'git-repo', path: join(root, 'g'), kind: 'git' })])
    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick(3)

    expect(store.getRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)
  })

  it('picks up a folder project added after the watch started, without a restart', async () => {
    const repos = [makeRepo({ id: 'git-repo', path: join(root, 'g'), kind: 'git' })]
    const store = makeStore(repos)

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: POLL_MS
    })
    const repoPath = join(root, 'late-project')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    repos.push(makeRepo({ id: 'late-repo', path: repoPath }))
    await tick(2)

    expect(store.updateRepo).toHaveBeenCalledWith(
      'late-repo',
      expect.objectContaining({ kind: 'git' })
    )
  })

  it('parks while the window is hidden and resumes when it becomes visible', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])
    const window = makeWindow()

    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()

    window.visible = false
    await mkdir(join(repoPath, '.git'))
    statCalls.length = 0
    await tick(3)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)

    window.visible = true
    notifyMainWindowBecameVisible()
    await tick()

    expect(store.updateRepo).toHaveBeenCalledWith(
      'folder-repo',
      expect.objectContaining({
        kind: 'git'
      })
    )
  })

  it('does not notify when the repo disappears between the marker check and the update', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    const repos = [makeRepo({ id: 'folder-repo', path: repoPath })]
    const store = makeStore(repos)
    store.updateRepo.mockReturnValue(null)
    const window = makeWindow()
    const onRepoUpgraded = vi.fn()

    startFolderRepoGitUpgradeWatch(store as never, window as never, {
      onRepoUpgraded,
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()

    expect(store.updateRepo).toHaveBeenCalled()
    expect(onRepoUpgraded).not.toHaveBeenCalled()
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('costs one .git stat per folder project per tick and never lists a directory', async () => {
    const paths = ['a', 'b', 'c'].map((name) => join(root, name))
    for (const repoPath of paths) {
      await mkdir(repoPath)
      // Sibling dirs a parent-directory scan would have to stat on every tick.
      await mkdir(join(repoPath, 'nested'))
    }
    const store = makeStore(
      paths.map((repoPath, index) => makeRepo({ id: `repo-${index}`, path: repoPath }))
    )

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    statCalls.length = 0
    await tick(4)

    expect(statCalls).toHaveLength(paths.length * 4)
    expect(new Set(statCalls)).toEqual(new Set(paths.map((repoPath) => join(repoPath, '.git'))))
    expect(readdirSpy).not.toHaveBeenCalled()
  })

  it('stops polling after the watch is disposed', async () => {
    const repoPath = join(root, 'my-project')
    await mkdir(repoPath)
    const store = makeStore([makeRepo({ id: 'folder-repo', path: repoPath })])

    startFolderRepoGitUpgradeWatch(store as never, makeWindow() as never, {
      onRepoUpgraded: vi.fn(),
      pollIntervalMs: POLL_MS,
      idlePollIntervalMs: IDLE_POLL_MS
    })
    await tick()
    stopFolderRepoGitUpgradeWatch()

    await mkdir(join(repoPath, '.git'))
    statCalls.length = 0
    await tick(3)

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(statCalls).toHaveLength(0)
  })
})
