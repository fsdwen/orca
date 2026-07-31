import { readBlobAtOid, type GitBufferExec, type GitExec } from './git-handler-ops'
import { parseBranchDiff } from './git-handler-utils'
import { buildDiffResult } from './git-diff-result'
import { parseNumstat } from '../shared/git-uncommitted-line-stats'
import { parseGitRevListParentOids } from '../shared/git-rev-list-output'

const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

function assertFullGitObjectId(value: string, label: string): void {
  if (!FULL_GIT_OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a full git object id`)
  }
}

export async function commitCompare(git: GitExec, worktreePath: string, commitId: string) {
  assertFullGitObjectId(commitId, 'commitId')
  let commitOid = ''
  try {
    const { stdout } = await git(
      ['rev-parse', '--verify', '--end-of-options', `${commitId}^{commit}`],
      worktreePath
    )
    commitOid = stdout.trim()
  } catch {
    return {
      summary: {
        commitOid: '',
        parentOid: null,
        compareRef: commitId,
        baseRef: 'parent',
        changedFiles: 0,
        status: 'invalid-commit',
        errorMessage: `Commit ${commitId} could not be resolved in this repository.`
      },
      entries: []
    }
  }

  const summary = {
    commitOid,
    parentOid: null as string | null,
    compareRef: commitOid.slice(0, 7),
    baseRef: 'empty tree',
    changedFiles: 0,
    status: 'ready' as const
  }

  try {
    const { stdout: parentsOut } = await git(
      ['rev-list', '--parents', '-n', '1', commitOid],
      worktreePath
    )
    const parentOids = parseGitRevListParentOids(parentsOut)
    const firstParent = parentOids[0] ?? null
    summary.parentOid = firstParent
    summary.baseRef = firstParent ? firstParent.slice(0, 7) : 'empty tree'

    const isMerge = parentOids.length > 1
    // Why: root commits have no parent tree; diff-tree --root asks git to
    // compare against the repository's empty tree without hardcoding hash format.
    const diffArgs = isMerge
      ? ['-c', 'core.quotePath=false', 'diff-tree', '-m', '--name-status', '-r', '-M', commitOid]
      : firstParent
        ? ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', firstParent, commitOid]
        : [
            '-c',
            'core.quotePath=false',
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-status',
            '-r',
            '-M',
            commitOid
          ]
    const numstatArgs = isMerge
      ? ['-c', 'core.quotePath=false', 'diff-tree', '-m', '-z', '--numstat', '-r', '-M', commitOid]
      : firstParent
        ? ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', firstParent, commitOid]
        : [
            '-c',
            'core.quotePath=false',
            'diff-tree',
            '-z',
            '--root',
            '--no-commit-id',
            '--numstat',
            '-r',
            '-M',
            commitOid
          ]
    const [{ stdout }, { stdout: numstat }] = await Promise.all([
      git(diffArgs, worktreePath),
      git(numstatArgs, worktreePath)
    ])
    const parsedEntries = parseBranchDiff(stdout, parseNumstat(numstat))

    // Why: diff-tree -m emits per-parent diffs that duplicate files.
    if (!isMerge) {
      summary.changedFiles = parsedEntries.length
      return { summary, entries: parsedEntries }
    }

    const seenByPath = new Map<string, Record<string, unknown>>()
    for (const entry of parsedEntries) {
      const path = entry.path as string
      const existing = seenByPath.get(path)
      if (!existing) {
        seenByPath.set(path, { ...entry })
      } else {
        existing.added = Math.max((existing.added as number) ?? 0, (entry.added as number) ?? 0)
        existing.removed = Math.max(
          (existing.removed as number) ?? 0,
          (entry.removed as number) ?? 0
        )
        if ((existing.status as string) === 'deleted' && (entry.status as string) !== 'deleted') {
          existing.status = entry.status
          existing.oldPath = entry.oldPath
        }
      }
    }
    const entries = [...seenByPath.values()]
    summary.changedFiles = entries.length
    return { summary, entries }
  } catch (error) {
    return {
      summary: {
        ...summary,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to load commit diff'
      },
      entries: []
    }
  }
}

export async function commitDiffEntry(
  gitBuffer: GitBufferExec,
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  }
) {
  assertFullGitObjectId(args.commitOid, 'commitOid')
  if (args.parentOid) {
    assertFullGitObjectId(args.parentOid, 'parentOid')
  }
  try {
    const oldPath = args.oldPath ?? args.filePath
    const left = args.parentOid
      ? await readBlobAtOid(gitBuffer, worktreePath, args.parentOid, oldPath)
      : { content: '', isBinary: false }
    const right = await readBlobAtOid(gitBuffer, worktreePath, args.commitOid, args.filePath)
    return buildDiffResult(
      left.content,
      right.content,
      left.isBinary,
      right.isBinary,
      args.filePath
    )
  } catch {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}
