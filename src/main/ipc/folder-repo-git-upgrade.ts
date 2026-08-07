import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../shared/types'
import type { Store } from '../persistence'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { isWslUncPath } from '../../shared/wsl-paths'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from './filesystem-auth'
import { notifyReposChanged } from './repos'
import { notifyWorktreesChanged } from './worktree-remote'
import {
  createWorktreePollerWindowVisibility,
  WORKTREE_BASE_BACKSTOP_TICKS,
  WORKTREE_BASE_POLL_INTERVAL_MS,
  type WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

// Why: with no folder project registered there is nothing to stat, so back the loop
// off instead of waking every 2s. Adding the first folder project is the only case
// that waits out one idle interval before the fast cadence starts.
const IDLE_POLL_INTERVAL_MS = WORKTREE_BASE_POLL_INTERVAL_MS * WORKTREE_BASE_BACKSTOP_TICKS

type UpgradeWatch = {
  store: Store
  mainWindow: BrowserWindow
  hasCandidates: boolean
  visibility: WorktreePollerWindowVisibility
  unsubscribeVisibility: () => void
  pollIntervalMs: number
  idlePollIntervalMs: number
  timer: ReturnType<typeof setTimeout> | null
  parkedWhileHidden: boolean
  disposed: boolean
}

let activeWatch: UpgradeWatch | null = null

// Why: `git init` on an SSH host or behind a WSL UNC root is not observable with a
// local stat, and those roots are exactly the ones the base watcher already refuses
// to poll natively. Desktop-local folder projects are the reported case (#11477).
function isUpgradeCandidate(repo: Repo): boolean {
  return (
    isFolderRepo(repo) &&
    !repo.connectionId &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

async function hasGitMarker(repoPath: string): Promise<boolean> {
  try {
    await stat(join(repoPath, '.git'))
    return true
  } catch {
    return false
  }
}

async function upgradeFolderRepo(watch: UpgradeWatch, repoId: string): Promise<void> {
  // Re-read after the marker stat: the repo can be removed or already upgraded mid-tick.
  const current = watch.store.getRepo(repoId)
  if (!current || !isUpgradeCandidate(current)) {
    return
  }
  const upgraded = watch.store.updateRepo(repoId, {
    kind: 'git',
    // Why: without an explicit value the upgraded repo reads as pre-rollout and would
    // show every external worktree, unlike a project added as git in the first place.
    externalWorktreeVisibility: 'hide'
  })
  if (!upgraded) {
    return
  }
  // Adding a git project prepares its worktree root; an upgrade has to do the same.
  await prepareLocalWorktreeRootForRepo(watch.store, upgraded)
  invalidateAuthorizedRootsCache()
  if (watch.disposed) {
    return
  }
  // Why: reuse the repo-mutation notifier so paired clients refetch too (#11994) and
  // the repo picks up the base/common-dir watchers it was skipped for as a folder.
  notifyReposChanged(watch.mainWindow)
  notifyWorktreesChanged(watch.mainWindow, repoId)
}

async function pollOnce(watch: UpgradeWatch): Promise<void> {
  const candidates = watch.store.getRepos().filter(isUpgradeCandidate)
  watch.hasCandidates = candidates.length > 0
  for (const repo of candidates) {
    if (watch.disposed) {
      return
    }
    if (await hasGitMarker(repo.path)) {
      await upgradeFolderRepo(watch, repo.id)
    }
  }
}

function scheduleTick(watch: UpgradeWatch): void {
  const delay = watch.hasCandidates ? watch.pollIntervalMs : watch.idlePollIntervalMs
  watch.timer = setTimeout(() => void runTick(watch), delay)
  watch.timer.unref?.()
}

async function runTick(watch: UpgradeWatch): Promise<void> {
  watch.timer = null
  if (watch.disposed) {
    return
  }
  if (!watch.visibility.isWindowVisible()) {
    // Parked: the visibility listener resumes the loop, so no timer is rescheduled.
    watch.parkedWhileHidden = true
    return
  }
  try {
    await pollOnce(watch)
  } catch {
    // Transient fs error: retry on the next tick.
  }
  if (!watch.disposed) {
    scheduleTick(watch)
  }
}

/**
 * Polls `<repo>/.git` for every local folder project and upgrades it to a git repo
 * once an external `git init` lands, so git affordances appear without a restart.
 * Idempotent: a re-attached main window replaces the one the running watch holds.
 * Parks while the window is hidden — one stat per folder project per tick, never a
 * directory listing.
 */
export function startFolderRepoGitUpgradeWatch(
  store: Store,
  mainWindow: BrowserWindow,
  options: { pollIntervalMs?: number; idlePollIntervalMs?: number } = {}
): void {
  if (mainWindow.isDestroyed()) {
    return
  }
  if (activeWatch) {
    activeWatch.store = store
    activeWatch.mainWindow = mainWindow
    return
  }
  const watch: UpgradeWatch = {
    store,
    mainWindow,
    // Why: assume work on the first tick rather than reading the store on the attach
    // path; the tick itself settles the cadence once it has seen the repo list.
    hasCandidates: true,
    visibility: createWorktreePollerWindowVisibility(() => watch.mainWindow),
    unsubscribeVisibility: () => {},
    pollIntervalMs: options.pollIntervalMs ?? WORKTREE_BASE_POLL_INTERVAL_MS,
    idlePollIntervalMs: options.idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS,
    timer: null,
    parkedWhileHidden: false,
    disposed: false
  }
  activeWatch = watch
  watch.unsubscribeVisibility = watch.visibility.onWindowBecameVisible(() => {
    if (watch.disposed || !watch.parkedWhileHidden) {
      return
    }
    watch.parkedWhileHidden = false
    void runTick(watch)
  })
  scheduleTick(watch)
}

export function stopFolderRepoGitUpgradeWatch(): void {
  const watch = activeWatch
  if (!watch) {
    return
  }
  activeWatch = null
  watch.disposed = true
  if (watch.timer) {
    clearTimeout(watch.timer)
    watch.timer = null
  }
  watch.unsubscribeVisibility()
}
