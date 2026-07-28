import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')

function sourceBetween(
  source: string,
  startPattern: string,
  endPattern: string
): string {
  const start = source.indexOf(startPattern)
  expect(
    start,
    `Expected to find "${startPattern}" in TaskPage.tsx`
  ).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(
    end,
    `Expected to find "${endPattern}" after "${startPattern}" in TaskPage.tsx`
  ).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TaskPage preset tab highlighting boundary', () => {
  // ── Button rendering ─────────────────────────────────

  it('derives active preset from derivedTaskPreset for both PR and Issues', () => {
    const presetSection = sourceBetween(
      TASK_PAGE_SOURCE,
      '{getGitHubTaskKindPresets(activeGithubTaskKind).map((option) => {',
      ') : taskSource ==='
    )

    expect(presetSection).toContain('derivedTaskPreset === option.id')
    // Must NOT reference activeTaskPreset for button highlighting
    expect(presetSection).not.toMatch(/\bactive\s*=\s*activeTaskPreset\b/)
  })

  // ── PR kind derivation ──────────────────────────────

  it('PR: derives my-prs from @me or gitHubLogin', () => {
    const derivationSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const derivedTaskPreset = useMemo<TaskViewPresetId | null>(',
      'selectedGitHubRepoExternalLink = useMemo'
    )

    expect(derivationSection).toContain("author === '@me'")
    expect(derivationSection).toContain('author === gitHubLogin')
    expect(derivationSection).toContain("return 'my-prs'")
    // Must not match any non-null author
    expect(derivationSection).not.toMatch(/if\s*\([^)]*author\s*!==\s*null/)
  })

  it('PR: derives review from @me or gitHubLogin', () => {
    const derivationSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const derivedTaskPreset = useMemo<TaskViewPresetId | null>(',
      'selectedGitHubRepoExternalLink = useMemo'
    )

    expect(derivationSection).toContain("reviewRequested === '@me'")
    expect(derivationSection).toContain('reviewRequested === gitHubLogin')
    expect(derivationSection).toContain("return 'review'")
  })

  it('PR: returns prs only when state is open or null, else null', () => {
    const derivationSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const derivedTaskPreset = useMemo<TaskViewPresetId | null>(',
      'selectedGitHubRepoExternalLink = useMemo'
    )

    expect(derivationSection).toContain("state === 'open'")
    expect(derivationSection).toContain("state === null")
    expect(derivationSection).toContain("return 'prs'")
    expect(derivationSection).toContain('return null')
  })

  it('PR: guards kind before query checks', () => {
    const derivationSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const derivedTaskPreset = useMemo<TaskViewPresetId | null>(',
      'selectedGitHubRepoExternalLink = useMemo'
    )

    const prsIndex = derivationSection.indexOf("activeGithubTaskKind === 'prs'")
    const issuesIndex = derivationSection.indexOf("activeGithubTaskKind === 'issues'")
    const authorIndex = derivationSection.indexOf('appliedTaskQuery.author')

    // PR branch must come before Issues branch
    expect(prsIndex).toBeGreaterThan(-1)
    expect(prsIndex).toBeLessThan(authorIndex)
    // Issues branch also gated on kind
    expect(issuesIndex).toBeGreaterThan(authorIndex)
  })

  // ── Issues kind derivation ──────────────────────────

  it('Issues: derives my-issues from @me or gitHubLogin', () => {
    const derivationSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const derivedTaskPreset = useMemo<TaskViewPresetId | null>(',
      'selectedGitHubRepoExternalLink = useMemo'
    )

    expect(derivationSection).toContain("assignee === '@me'")
    expect(derivationSection).toContain('assignee === gitHubLogin')
    expect(derivationSection).toContain("return 'my-issues'")
  })

  it('Issues: returns issues (Open) when state is open or null, else null', () => {
    const derivationSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const derivedTaskPreset = useMemo<TaskViewPresetId | null>(',
      'selectedGitHubRepoExternalLink = useMemo'
    )

    // Inside the issues branch
    const issuesBranch = derivationSection.slice(
      derivationSection.indexOf("activeGithubTaskKind === 'issues'"),
      derivationSection.lastIndexOf('return null')
    )

    expect(issuesBranch).toContain("state === 'open'")
    expect(issuesBranch).toContain("state === null")
    expect(issuesBranch).toContain("return 'issues'")
    expect(issuesBranch).toContain('return null')
  })

  // ── Data source ─────────────────────────────────────

  it('loads gitHubLogin from window.api.gh.viewer()', () => {
    const viewerSection = sourceBetween(
      TASK_PAGE_SOURCE,
      "const [gitHubLogin, setGitHubLogin] = useState<string | null>(null)",
      'paginationGenerationRef = useRef(0)'
    )

    expect(viewerSection).toContain("window.api.gh.viewer()")
    expect(viewerSection).toContain("setGitHubLogin(viewer.login)")
  })
})
