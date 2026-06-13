export type ConsoleLevel =
  | "log"
  | "info"
  | "warning"
  | "error"
  | "debug"
  | "trace"
  | "exception"

export type ConsoleEventRecord = {
  id: number
  level: ConsoleLevel
  text: string
  source?: string
  timestamp: number
  args?: unknown[]
}

export type ScriptRecord = {
  scriptId: string
  url: string
}

export type BreakpointResolvedLocation = {
  scriptId?: string
  url?: string
  lineNumber: number
  columnNumber: number
}

export type BreakpointRecord = {
  breakpointId: string
  filePath: string
  line: number
  column?: number
  condition?: string
  url: string
  sourceFilePath?: string
  sourceLine?: number
  resolvedLocations: BreakpointResolvedLocation[]
}

export type CallFrameSummary = {
  callFrameId: string
  functionName?: string
  url?: string
  scriptId?: string
  lineNumber: number
  columnNumber: number
}

export type PausedRecord = {
  reason?: string
  hitBreakpoints?: string[]
  callFrames: CallFrameSummary[]
  timestamp: number
}

export class InspectorState {
  private readonly capacity: number
  private logs: ConsoleEventRecord[] = []
  private nextLogId = 1
  private readonly scripts = new Map<string, ScriptRecord>()
  private readonly breakpoints = new Map<string, BreakpointRecord>()
  private paused: PausedRecord | null = null

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  reset(): void {
    this.logs = []
    this.nextLogId = 1
    this.scripts.clear()
    this.breakpoints.clear()
    this.paused = null
  }

  addConsole(record: Omit<ConsoleEventRecord, "id">): ConsoleEventRecord {
    const next: ConsoleEventRecord = {
      ...record,
      id: this.nextLogId++,
    }
    this.logs.push(next)
    if (this.logs.length > this.capacity) {
      this.logs.splice(0, this.logs.length - this.capacity)
    }
    return next
  }

  getRecentLogs(limit = 20, level?: string): ConsoleEventRecord[] {
    const filtered = level
      ? this.logs.filter((entry) => entry.level === level)
      : this.logs
    return filtered.slice(Math.max(0, filtered.length - limit))
  }

  upsertScript(scriptId: string, url: string): void {
    if (!scriptId) {
      return
    }
    this.scripts.set(scriptId, { scriptId, url })
  }

  getScriptUrl(scriptId?: string): string | undefined {
    if (!scriptId) {
      return undefined
    }
    return this.scripts.get(scriptId)?.url
  }

  listScripts(): ScriptRecord[] {
    return [...this.scripts.values()].sort((left, right) =>
      left.url.localeCompare(right.url)
    )
  }

  setPaused(record: PausedRecord): void {
    this.paused = record
  }

  clearPaused(): void {
    this.paused = null
  }

  getPaused(): PausedRecord | null {
    return this.paused
  }

  addBreakpoint(record: BreakpointRecord): void {
    this.breakpoints.set(record.breakpointId, record)
  }

  removeBreakpoint(breakpointId: string): boolean {
    return this.breakpoints.delete(breakpointId)
  }

  clearBreakpoints(): void {
    this.breakpoints.clear()
  }

  listBreakpoints(): BreakpointRecord[] {
    return [...this.breakpoints.values()].sort((left, right) => {
      const byFile = left.filePath.localeCompare(right.filePath)
      if (byFile !== 0) {
        return byFile
      }
      return left.line - right.line
    })
  }

  findBreakpointByLocation(
    filePath: string,
    line: number
  ): BreakpointRecord | undefined {
    return this.listBreakpoints().find(
      (breakpoint) =>
        breakpoint.filePath === filePath && breakpoint.line === line
    )
  }

  findBreakpointsByLocation(
    filePath: string,
    line: number
  ): BreakpointRecord[] {
    return this.listBreakpoints().filter(
      (breakpoint) =>
        breakpoint.filePath === filePath && breakpoint.line === line
    )
  }
}
