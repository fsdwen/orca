/**
 * Dense-SGR density probe shared by the main delivery gate (input-protection
 * drop) and the renderer output scheduler (freeze/drop/parse-clock pacing).
 *
 * Why: character-level SGR styling parses ~50x slower than plain text in
 * xterm. The main gate must use the SAME threshold as the renderer scheduler,
 * or it would drop ordinary plain-text floods and TUI repaints (which parse
 * fine) while the user types.
 */

/** Cheap density probe: does this chunk carry enough SGR styling to matter? */
export function isDenseSgr(data: string): boolean {
  let sgrCount = 0
  let charCount = 0
  let index = 0
  const length = data.length
  while (index < length) {
    if (data.charCodeAt(index) === 0x1b && data[index + 1] === '[') {
      let cursor = index + 2
      while (cursor < length && !(data[cursor] >= '@' && data[cursor] <= '~')) {
        cursor += 1
      }
      if (cursor < length && data[cursor] === 'm') {
        sgrCount += 1
      }
      index = cursor < length ? cursor + 1 : length
    } else {
      charCount += 1
      index += 1
    }
  }
  // Character-level highlighting emits ~1 SGR per character; the parse-starved
  // threshold is one SGR per ~2 characters. Non-SGR CSI (cursor moves, DEC
  // modes) does not count. Token/word-level styling (~1 per 10+ chars) parses
  // fine and must NOT trip the input-protection freeze.
  return charCount > 0 && sgrCount * 2 >= charCount
}
