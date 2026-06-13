import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import {
  Container,
  Key,
  Spacer,
  Text,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui"

type SourceLineBreakpointState = {
  hasBreakpoint: boolean
}

export type SourceBreakpointViewerOptions = {
  filePath: string
  lines: string[]
  initialLine?: number
  getBreakpointState: (line: number) => SourceLineBreakpointState
  onToggleLine: (line: number) => Promise<string>
  onClearLine: (line: number) => Promise<string>
}

const DEFAULT_STATUS_TEXT =
  "space/enter toggle • c clear • / search • n/N next/prev • ↑↓ move • pgup/pgdn scroll • esc close"

export function createSourceBreakpointViewer(
  tui: { requestRender: () => void },
  theme: {
    fg: (color: string, text: string) => string
    bold: (text: string) => string
  },
  done: (result: undefined) => void,
  options: SourceBreakpointViewerOptions
) {
  let cursorLine = Math.min(
    Math.max(options.initialLine ?? 1, 1),
    Math.max(options.lines.length, 1)
  )
  let viewportStart = Math.max(1, cursorLine - 8)
  let statusText = DEFAULT_STATUS_TEXT
  let busy = false
  let searchMode = false
  let searchQuery = ""

  const container = new Container()
  const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s))
  const title = new Text("", 1, 0)
  const helper = new Text("", 1, 0)
  const body = new Text("", 1, 0)
  const footer = new Text("", 1, 0)
  const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s))

  function getViewportHeight(): number {
    return 40
  }

  function getMatchingLines(): number[] {
    if (!searchQuery) {
      return []
    }

    const normalizedQuery = searchQuery.toLowerCase()
    const matches: number[] = []
    for (
      let lineNumber = 1;
      lineNumber <= options.lines.length;
      lineNumber += 1
    ) {
      const source = options.lines[lineNumber - 1] ?? ""
      if (source.toLowerCase().includes(normalizedQuery)) {
        matches.push(lineNumber)
      }
    }
    return matches
  }

  function refreshSearchStatus(): void {
    if (!searchMode && !searchQuery) {
      statusText = DEFAULT_STATUS_TEXT
      return
    }

    const matches = getMatchingLines()
    statusText = searchMode
      ? `Search: ${searchQuery}`
      : `Search: "${searchQuery}" (${matches.length} match${matches.length === 1 ? "" : "es"}) • n/N navigate • / edit`
  }

  function findMatch(direction: 1 | -1): number | null {
    const matches = getMatchingLines()
    if (matches.length === 0) {
      return null
    }

    if (direction > 0) {
      const next = matches.find((lineNumber) => lineNumber > cursorLine)
      return next ?? matches[0] ?? null
    }

    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const lineNumber = matches[index]
      if ((lineNumber ?? 0) < cursorLine) {
        return lineNumber ?? null
      }
    }
    return matches[matches.length - 1] ?? null
  }

  function jumpToMatch(direction: 1 | -1): boolean {
    const match = findMatch(direction)
    if (!match) {
      statusText = searchQuery
        ? `No matches for "${searchQuery}"`
        : "No active search"
      return false
    }

    cursorLine = match
    refreshSearchStatus()
    return true
  }

  function clampViewport(): void {
    const maxStart = Math.max(1, options.lines.length - getViewportHeight() + 1)
    viewportStart = Math.min(Math.max(viewportStart, 1), maxStart)
    if (cursorLine < viewportStart) {
      viewportStart = cursorLine
    }
    const viewportEnd = viewportStart + getViewportHeight() - 1
    if (cursorLine > viewportEnd) {
      viewportStart = cursorLine - getViewportHeight() + 1
    }
  }

  function renderBody(width: number): string {
    clampViewport()
    const visibleLines: string[] = []
    const viewportEnd = Math.min(
      options.lines.length,
      viewportStart + getViewportHeight() - 1
    )
    const matchingLines = new Set(getMatchingLines())

    for (
      let lineNumber = viewportStart;
      lineNumber <= viewportEnd;
      lineNumber += 1
    ) {
      const source = options.lines[lineNumber - 1] ?? ""
      const lineState = options.getBreakpointState(lineNumber)
      const isCursor = lineNumber === cursorLine
      const isSearchMatch = matchingLines.has(lineNumber)
      const marker = lineState.hasBreakpoint ? "●" : "·"
      const searchMarker = isSearchMatch ? "?" : " "
      const prefix = `${isCursor ? ">" : " "} ${marker}${searchMarker} ${String(lineNumber).padStart(4, " ")} `
      const rawLine = `${prefix}${source}`
      const text = truncateToWidth(rawLine, Math.max(width - 2, 1))
      if (isCursor) {
        visibleLines.push(theme.fg("accent", text))
      } else if (lineState.hasBreakpoint) {
        visibleLines.push(theme.fg("success", text))
      } else if (isSearchMatch) {
        visibleLines.push(theme.fg("warning", text))
      } else {
        visibleLines.push(text)
      }
    }

    return visibleLines.join("\n")
  }

  function rebuild(width = 120): void {
    title.setText(
      theme.fg(
        "accent",
        theme.bold(`Source breakpoints · ${options.filePath}:${cursorLine}`)
      )
    )
    helper.setText(theme.fg(searchMode ? "warning" : "dim", statusText))
    body.setText(renderBody(width))
    footer.setText(
      theme.fg(
        busy ? "warning" : "muted",
        `line ${cursorLine}/${Math.max(options.lines.length, 1)} · ${busy ? "working..." : searchMode ? "search mode" : "read-only source view"}`
      )
    )
  }

  container.addChild(topBorder)
  container.addChild(title)
  container.addChild(helper)
  container.addChild(new Spacer(1))
  container.addChild(body)
  container.addChild(new Spacer(1))
  container.addChild(footer)
  container.addChild(bottomBorder)

  async function performAction(action: () => Promise<string>): Promise<void> {
    if (busy) {
      return
    }
    busy = true
    statusText = "Working..."
    rebuild()
    tui.requestRender()
    try {
      statusText = await action()
    } catch (error) {
      statusText = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
      if (!searchMode && searchQuery) {
        refreshSearchStatus()
      }
      rebuild()
      tui.requestRender()
    }
  }

  refreshSearchStatus()
  rebuild()

  return {
    render(width: number) {
      rebuild(width)
      return container.render(width)
    },
    invalidate() {
      container.invalidate()
      rebuild()
    },
    handleInput(data: string) {
      if (busy) {
        return
      }

      if (searchMode) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          searchMode = false
          refreshSearchStatus()
          rebuild()
          tui.requestRender()
          return
        }
        if (matchesKey(data, Key.enter)) {
          searchMode = false
          jumpToMatch(1)
          rebuild()
          tui.requestRender()
          return
        }
        if (matchesKey(data, Key.backspace)) {
          searchQuery = searchQuery.slice(0, -1)
          if (searchQuery) {
            jumpToMatch(1)
          } else {
            refreshSearchStatus()
          }
          rebuild()
          tui.requestRender()
          return
        }

        const hasControlChars = [...data].some((char) => {
          const code = char.charCodeAt(0)
          return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
        })
        if (!hasControlChars && data.length > 0) {
          searchQuery += data
          jumpToMatch(1)
          rebuild()
          tui.requestRender()
        }
        return
      }

      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done(undefined)
        return
      }
      if (data === "/") {
        searchMode = true
        refreshSearchStatus()
      } else if (data === "n") {
        jumpToMatch(1)
      } else if (data === "N") {
        jumpToMatch(-1)
      } else if (matchesKey(data, Key.up)) {
        cursorLine = Math.max(1, cursorLine - 1)
      } else if (matchesKey(data, Key.down)) {
        cursorLine = Math.min(options.lines.length, cursorLine + 1)
      } else if (matchesKey(data, Key.home)) {
        cursorLine = 1
      } else if (matchesKey(data, Key.end)) {
        cursorLine = options.lines.length
      } else if (matchesKey(data, "pageup")) {
        cursorLine = Math.max(1, cursorLine - getViewportHeight())
      } else if (matchesKey(data, "pagedown")) {
        cursorLine = Math.min(
          options.lines.length,
          cursorLine + getViewportHeight()
        )
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        void performAction(() => options.onToggleLine(cursorLine))
        return
      } else if (data === "c" || data === "C") {
        void performAction(() => options.onClearLine(cursorLine))
        return
      } else {
        return
      }

      if (!searchMode) {
        refreshSearchStatus()
      }
      rebuild()
      tui.requestRender()
    },
  }
}
