import { existsSync, readFileSync } from "node:fs"
import { basename, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Type } from "@earendil-works/pi-ai"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
  DEFAULT_CONFIG,
  loadInspectorConfig,
  type InspectorRuntimeConfig,
} from "./config.js"
import { InspectorClient, type CdpEventMessage } from "./inspector/client.js"
import { discoverInspectorTarget } from "./inspector/discover.js"
import {
  InspectorState,
  type BreakpointRecord,
  type CallFrameSummary,
  type ConsoleEventRecord,
  type ConsoleLevel,
} from "./inspector/state.js"
import {
  formatConsoleText,
  formatRemoteObject,
  formatScriptLocation,
  normalizeScriptUrl,
  type RuntimeRemoteObject,
} from "./tool-formatters.js"
import { createSourceBreakpointViewer } from "./source-breakpoint-viewer.js"
import { SourceMapResolver, type SourceMappedLocation } from "./source-map.js"

type AttachTarget = {
  host: string
  port: number
  targetId?: string
}

type ActiveConnection = AttachTarget & {
  wsUrl: string
  targetTitle?: string
  targetUrl?: string
}

type RawCallFrame = {
  callFrameId?: string
  functionName?: string
  url?: string
  location?: {
    scriptId?: string
    lineNumber?: number
    columnNumber?: number
  }
}

type RawExceptionDetails = {
  text?: string
  url?: string
  exception?: {
    description?: string
  }
}

type SetBreakpointByUrlResult = {
  breakpointId?: string
  locations?: Array<{
    scriptId?: string
    lineNumber?: number
    columnNumber?: number
  }>
}

type ResolvedBreakpointInput = {
  displayFilePath: string
  displayLine: number
  runtimeAbsolutePath: string
  runtimeLine: number
  runtimeColumn?: number
  condition?: string
  sourceFilePath?: string
  sourceLine?: number
}

const STATUS_KEY = "pi-node-inspect"
const WIDGET_KEY = "pi-node-inspect-recent"

function parseHostPort(input: string, fallback = DEFAULT_CONFIG): AttachTarget {
  const trimmed = input.trim()
  if (!trimmed) {
    return { host: fallback.host, port: fallback.port }
  }
  const [hostPart, portPart] = trimmed.split(":")
  const host = hostPart?.trim() || fallback.host
  const port = portPart ? Number.parseInt(portPart, 10) : fallback.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid inspector port: ${portPart}`)
  }
  return { host, port }
}

function parseFileLineArg(
  value: string,
  cwd: string
): { filePath: string; absolutePath: string; line: number } {
  const match = value.trim().match(/^(.*):(\d+)$/)
  if (!match) {
    throw new Error(`Expected <file:line>, received: ${value}`)
  }
  const filePart = match[1]?.trim()
  const line = Number.parseInt(match[2] ?? "", 10)
  if (!filePart || !Number.isInteger(line) || line < 1) {
    throw new Error(`Invalid breakpoint location: ${value}`)
  }
  const absolutePath = resolve(cwd, filePart)
  return {
    filePath: relative(cwd, absolutePath) || basename(absolutePath),
    absolutePath,
    line,
  }
}

function toInspectorUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href
}

function summarizeCallFrame(
  frame: RawCallFrame,
  state: InspectorState
): CallFrameSummary {
  const location = frame.location ?? {}
  const url = frame.url || state.getScriptUrl(location.scriptId)
  return {
    callFrameId: String(frame.callFrameId ?? ""),
    functionName: frame.functionName || "<anonymous>",
    url,
    scriptId: location.scriptId,
    lineNumber: Number(location.lineNumber ?? 0),
    columnNumber: Number(location.columnNumber ?? 0),
  }
}

function formatLocation(
  frame: CallFrameSummary | null | undefined,
  cwd: string
): string {
  return formatScriptLocation(frame, cwd)
}

function updateUi(
  ctx: ExtensionContext | null,
  activeConnection: ActiveConnection | null,
  state: InspectorState
): void {
  if (!ctx) {
    return
  }
  if (!activeConnection) {
    ctx.ui.setStatus(STATUS_KEY, undefined)
    ctx.ui.setWidget(WIDGET_KEY, undefined)
    return
  }

  const paused = state.getPaused()
  const status = paused
    ? `⏸ paused ${formatLocation(paused.callFrames[0], ctx.cwd)}`
    : `🔌 inspect ${activeConnection.host}:${activeConnection.port}`
  ctx.ui.setStatus(
    STATUS_KEY,
    ctx.ui.theme.fg(paused ? "warning" : "accent", status)
  )

  const lines: string[] = []
  if (paused?.callFrames[0]) {
    lines.push(
      `⏸ ${formatLocation(paused.callFrames[0], ctx.cwd)} · ${paused.reason ?? "paused"}`
    )
  }
  for (const entry of state.getRecentLogs(5)) {
    lines.push(`[${entry.level}] ${entry.text}`)
  }
  ctx.ui.setWidget(
    WIDGET_KEY,
    lines.length > 0 ? lines : ["Inspector attached"]
  )
}

function buildStatusText(
  ctx: ExtensionContext,
  activeConnection: ActiveConnection | null,
  state: InspectorState
): string {
  if (!activeConnection) {
    return "Inspector is detached."
  }
  const paused = state.getPaused()
  const breakpoints = state.listBreakpoints()
  return [
    "connected: yes",
    `target: ${activeConnection.host}:${activeConnection.port}`,
    `title: ${activeConnection.targetTitle ?? "node"}`,
    `url: ${activeConnection.targetUrl ?? activeConnection.wsUrl}`,
    `paused: ${paused ? formatLocation(paused.callFrames[0], ctx.cwd) : "no"}`,
    `breakpoints: ${breakpoints.length}`,
    `scripts: ${state.listScripts().length}`,
  ].join("\n")
}

function buildPauseDetails(
  ctx: ExtensionContext,
  state: InspectorState
): string {
  const paused = state.getPaused()
  if (!paused) {
    return "Inspector is not paused."
  }
  const frames = paused.callFrames
    .map(
      (frame, index) =>
        `${index}. ${frame.functionName ?? "<anonymous>"} @ ${formatLocation(frame, ctx.cwd)}`
    )
    .join("\n")
  return `reason: ${paused.reason ?? "paused"}\n${frames}`
}

function formatResolvedBreakpointLocation(
  breakpoint: BreakpointRecord,
  ctx: ExtensionContext,
  state: InspectorState
): string {
  if (breakpoint.resolvedLocations.length === 0) {
    return "unbound"
  }

  return breakpoint.resolvedLocations
    .map((location) => {
      const url = location.url ?? state.getScriptUrl(location.scriptId)
      return formatScriptLocation(
        {
          url,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        },
        ctx.cwd
      )
    })
    .join(", ")
}

function buildBreakpointText(
  breakpoints: BreakpointRecord[],
  ctx: ExtensionContext,
  state: InspectorState
): string {
  if (breakpoints.length === 0) {
    return "No breakpoints set."
  }
  return breakpoints
    .map(
      (breakpoint) =>
        `${breakpoint.breakpointId} · ${breakpoint.filePath}:${breakpoint.line}${breakpoint.condition ? ` if ${breakpoint.condition}` : ""} -> ${formatResolvedBreakpointLocation(breakpoint, ctx, state)}`
    )
    .join("\n")
}

function buildScriptListText(
  ctx: ExtensionContext,
  state: InspectorState,
  filterText?: string,
  limit = 50
): string {
  const normalizedFilter = filterText?.trim().toLowerCase()
  const scripts = state
    .listScripts()
    .filter((script) => {
      if (!normalizedFilter) {
        return true
      }
      return normalizeScriptUrl(script.url, ctx.cwd)
        .toLowerCase()
        .includes(normalizedFilter)
    })
    .slice(0, limit)

  if (scripts.length === 0) {
    return normalizedFilter
      ? `No loaded scripts matched: ${filterText}`
      : "No loaded scripts captured yet."
  }

  return scripts
    .map(
      (script) =>
        `${script.scriptId} · ${normalizeScriptUrl(script.url, ctx.cwd)}`
    )
    .join("\n")
}

export default function piNodeInspect(pi: ExtensionAPI): void {
  let currentContext: ExtensionContext | null = null
  let state = new InspectorState(DEFAULT_CONFIG.bufferSize)
  let client: InspectorClient | null = null
  let activeConnection: ActiveConnection | null = null
  let runtimeConfig: InspectorRuntimeConfig = loadInspectorConfig()
  let sourceMapResolver = new SourceMapResolver(process.cwd())

  async function detach(
    ctx: ExtensionContext,
    message?: string
  ): Promise<void> {
    if (client) {
      await client.disconnect()
      client.removeAllListeners()
      client = null
    }
    activeConnection = null
    state.reset()
    updateUi(ctx, activeConnection, state)
    if (message) {
      ctx.ui.notify(message, "info")
    }
  }

  async function attach(
    ctx: ExtensionContext,
    target: AttachTarget
  ): Promise<void> {
    if (client) {
      await detach(ctx)
    }
    const discovered = await discoverInspectorTarget(target)
    state = new InspectorState(runtimeConfig.bufferSize)
    client = new InspectorClient(discovered.webSocketDebuggerUrl)
    activeConnection = {
      ...target,
      wsUrl: discovered.webSocketDebuggerUrl,
      targetTitle: discovered.target.title,
      targetUrl: discovered.target.url,
    }

    client.on("notification", async (message: CdpEventMessage) => {
      if (!currentContext) {
        return
      }
      await handleNotification(message, currentContext)
    })
    client.on("connected", async () => {
      await client?.send("Runtime.enable")
      await client?.send("Debugger.enable")
      updateUi(currentContext, activeConnection, state)
    })
    client.on("disconnected", () =>
      updateUi(currentContext, activeConnection, state)
    )
    client.on("reconnecting", (attempt, delayMs) => {
      currentContext?.ui.notify(
        `Inspector reconnecting (${attempt}) in ${delayMs}ms`,
        "warning"
      )
    })
    await client.connect()
    updateUi(ctx, activeConnection, state)
    ctx.ui.notify(`Inspector attached to ${target.host}:${target.port}`, "info")
  }

  async function handleNotification(
    message: CdpEventMessage,
    ctx: ExtensionContext
  ): Promise<void> {
    switch (message.method) {
      case "Debugger.scriptParsed": {
        const scriptId = String(message.params?.scriptId ?? "")
        const url = String(message.params?.url ?? "")
        if (scriptId && url) {
          state.upsertScript(scriptId, url)
        }
        break
      }
      case "Runtime.consoleAPICalled": {
        const type = String(message.params?.type ?? "log") as ConsoleLevel
        if (runtimeConfig.ignoreLevels.includes(type)) {
          break
        }
        const args = Array.isArray(message.params?.args)
          ? (message.params?.args as RuntimeRemoteObject[])
          : []
        const text = formatConsoleText(args)
        state.addConsole({
          level: type,
          text: text || `<${type}>`,
          source: String(message.params?.executionContextId ?? ""),
          timestamp: Date.now(),
          args,
        })
        break
      }
      case "Runtime.exceptionThrown": {
        if (runtimeConfig.ignoreLevels.includes("exception")) {
          break
        }
        const details =
          (message.params?.exceptionDetails as
            | RawExceptionDetails
            | undefined) ?? {}
        const text = String(
          details.text || details.exception?.description || "Uncaught exception"
        )
        state.addConsole({
          level: "exception",
          text,
          timestamp: Date.now(),
          source: normalizeScriptUrl(details.url, ctx.cwd),
        })
        break
      }
      case "Debugger.paused": {
        const callFrames = Array.isArray(message.params?.callFrames)
          ? (message.params?.callFrames as RawCallFrame[]).map((frame) =>
              summarizeCallFrame(frame, state)
            )
          : []
        state.setPaused({
          reason:
            typeof message.params?.reason === "string"
              ? message.params.reason
              : undefined,
          hitBreakpoints: Array.isArray(message.params?.hitBreakpoints)
            ? (message.params?.hitBreakpoints as string[])
            : [],
          callFrames,
          timestamp: Date.now(),
        })
        if (runtimeConfig.autoInjectPauseEvents && callFrames[0]) {
          pi.sendUserMessage(
            `[inspector] paused at ${formatLocation(callFrames[0], ctx.cwd)} (${message.params?.reason ?? "paused"})`,
            {
              deliverAs: "followUp",
            }
          )
        }
        break
      }
      case "Debugger.resumed": {
        state.clearPaused()
        break
      }
    }
    updateUi(ctx, activeConnection, state)
  }

  function isRuntimeScriptLoaded(
    runtimeLocation: SourceMappedLocation
  ): boolean {
    return state.listScripts().some((script) => {
      if (script.url === runtimeLocation.runtimeUrl) {
        return true
      }
      if (script.url.startsWith("file://")) {
        return fileURLToPath(script.url) === runtimeLocation.runtimeAbsolutePath
      }
      return false
    })
  }

  function getSourceBreakpoints(
    filePath: string,
    line: number
  ): BreakpointRecord[] {
    return state.findBreakpointsByLocation(filePath, line)
  }

  async function removeBreakpoints(
    ctx: ExtensionContext,
    breakpoints: BreakpointRecord[]
  ): Promise<number> {
    if (!client) {
      throw new Error("Inspector is not attached.")
    }

    for (const breakpoint of breakpoints) {
      await client.send("Debugger.removeBreakpoint", {
        breakpointId: breakpoint.breakpointId,
      })
      state.removeBreakpoint(breakpoint.breakpointId)
    }
    updateUi(ctx, activeConnection, state)
    return breakpoints.length
  }

  function resolveSourceRuntimeLocations(
    ctx: ExtensionContext,
    rawLocation: string
  ): {
    filePath: string
    absolutePath: string
    line: number
    runtimeLocations: SourceMappedLocation[]
  } {
    const location = parseFileLineArg(rawLocation, ctx.cwd)
    if (!existsSync(location.absolutePath)) {
      throw new Error(`File not found: ${location.absolutePath}`)
    }

    const runtimeLocations = sourceMapResolver
      .resolveSourceLine(location.absolutePath, location.line)
      .filter((runtimeLocation) => isRuntimeScriptLoaded(runtimeLocation))

    if (runtimeLocations.length === 0) {
      throw new Error(
        `No loaded runtime sourcemap mapping found for ${location.filePath}:${location.line}. Use /inspect-scripts to inspect loaded runtime files.`
      )
    }

    return {
      filePath: location.filePath,
      absolutePath: location.absolutePath,
      line: location.line,
      runtimeLocations,
    }
  }

  async function setResolvedBreakpoint(
    ctx: ExtensionContext,
    input: ResolvedBreakpointInput
  ): Promise<BreakpointRecord> {
    if (!client) {
      throw new Error("Inspector is not attached.")
    }

    const url = toInspectorUrl(input.runtimeAbsolutePath)
    const result = (await client.send("Debugger.setBreakpointByUrl", {
      url,
      lineNumber: input.runtimeLine - 1,
      columnNumber: input.runtimeColumn ?? 0,
      condition: input.condition,
    })) as SetBreakpointByUrlResult

    const breakpoint: BreakpointRecord = {
      breakpointId: String(result.breakpointId ?? ""),
      filePath: input.displayFilePath,
      line: input.displayLine,
      condition: input.condition,
      url,
      sourceFilePath: input.sourceFilePath,
      sourceLine: input.sourceLine,
      column:
        typeof result.locations?.[0]?.columnNumber === "number"
          ? result.locations[0].columnNumber
          : undefined,
      resolvedLocations: (result.locations ?? []).map((resolvedLocation) => ({
        scriptId: resolvedLocation.scriptId,
        url: state.getScriptUrl(resolvedLocation.scriptId),
        lineNumber: Number(
          resolvedLocation.lineNumber ?? input.runtimeLine - 1
        ),
        columnNumber: Number(resolvedLocation.columnNumber ?? 0),
      })),
    }
    state.addBreakpoint(breakpoint)
    updateUi(ctx, activeConnection, state)
    return breakpoint
  }

  async function setBreakpoint(
    ctx: ExtensionContext,
    rawLocation: string,
    condition?: string
  ): Promise<BreakpointRecord> {
    const location = parseFileLineArg(rawLocation, ctx.cwd)
    if (!existsSync(location.absolutePath)) {
      throw new Error(`File not found: ${location.absolutePath}`)
    }

    return setResolvedBreakpoint(ctx, {
      displayFilePath: location.filePath,
      displayLine: location.line,
      runtimeAbsolutePath: location.absolutePath,
      runtimeLine: location.line,
      condition,
    })
  }

  async function toggleSourceBreakpoint(
    ctx: ExtensionContext,
    rawLocation: string,
    condition?: string
  ): Promise<string> {
    const location = parseFileLineArg(rawLocation, ctx.cwd)
    const existing = getSourceBreakpoints(location.filePath, location.line)
    if (existing.length > 0) {
      const cleared = await removeBreakpoints(ctx, existing)
      return `Cleared ${cleared} breakpoint(s) for ${location.filePath}:${location.line}`
    }

    const resolved = resolveSourceRuntimeLocations(ctx, rawLocation)
    const created: BreakpointRecord[] = []
    for (const runtimeLocation of resolved.runtimeLocations) {
      created.push(
        await setResolvedBreakpoint(ctx, {
          displayFilePath: resolved.filePath,
          displayLine: resolved.line,
          runtimeAbsolutePath: runtimeLocation.runtimeAbsolutePath,
          runtimeLine: runtimeLocation.runtimeLine,
          runtimeColumn: runtimeLocation.runtimeColumn,
          condition,
          sourceFilePath: resolved.filePath,
          sourceLine: resolved.line,
        })
      )
    }

    return `Breakpoint set: ${resolved.filePath}:${resolved.line} -> ${created
      .map((breakpoint) =>
        formatResolvedBreakpointLocation(breakpoint, ctx, state)
      )
      .join(", ")}`
  }

  async function clearBreakpoint(
    idOrLocation: string,
    ctx: ExtensionContext
  ): Promise<string> {
    if (!client) {
      throw new Error("Inspector is not attached.")
    }
    if (idOrLocation === "all") {
      for (const breakpoint of state.listBreakpoints()) {
        await client.send("Debugger.removeBreakpoint", {
          breakpointId: breakpoint.breakpointId,
        })
        state.removeBreakpoint(breakpoint.breakpointId)
      }
      updateUi(ctx, activeConnection, state)
      return "Cleared all breakpoints."
    }

    const match = idOrLocation.match(/^(.*):(\d+)$/)
    if (match) {
      const parsed = parseFileLineArg(idOrLocation, ctx.cwd)
      const breakpoints = state.findBreakpointsByLocation(
        parsed.filePath,
        parsed.line
      )
      if (breakpoints.length === 0) {
        throw new Error(`Breakpoint not found: ${idOrLocation}`)
      }
      const cleared = await removeBreakpoints(ctx, breakpoints)
      return `Cleared ${cleared} breakpoint(s) for ${parsed.filePath}:${parsed.line}`
    }

    const breakpoint = state
      .listBreakpoints()
      .find((item) => item.breakpointId === idOrLocation)
    if (!breakpoint) {
      throw new Error(`Breakpoint not found: ${idOrLocation}`)
    }
    await removeBreakpoints(ctx, [breakpoint])
    return `Cleared ${breakpoint.breakpointId}`
  }

  async function evaluateExpression(
    expression: string,
    frameIndex: number | undefined
  ): Promise<Record<string, unknown>> {
    if (!client) {
      throw new Error("Inspector is not attached.")
    }
    const paused = state.getPaused()
    if (paused && typeof frameIndex === "number") {
      const frame = paused.callFrames[frameIndex]
      if (!frame) {
        throw new Error(`Paused frame ${frameIndex} not found.`)
      }
      return (await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: false,
      })) as Record<string, unknown>
    }
    return (await client.send("Runtime.evaluate", {
      expression,
      returnByValue: false,
    })) as Record<string, unknown>
  }

  pi.registerFlag("inspect-attach", {
    description: "Auto-attach the Node inspector on session start.",
    type: "boolean",
    default: false,
  })
  pi.registerFlag("inspect-host", {
    description: "Inspector host to use with --inspect-attach.",
    type: "string",
    default: DEFAULT_CONFIG.host,
  })
  pi.registerFlag("inspect-port", {
    description: "Inspector port to use with --inspect-attach.",
    type: "string",
    default: String(DEFAULT_CONFIG.port),
  })

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx
    runtimeConfig = loadInspectorConfig(ctx.cwd)
    sourceMapResolver = new SourceMapResolver(ctx.cwd)
    const shouldAttach = Boolean(pi.getFlag("inspect-attach"))
    if (!shouldAttach) {
      updateUi(ctx, activeConnection, state)
      return
    }
    const host = String(pi.getFlag("inspect-host") ?? DEFAULT_CONFIG.host)
    const port = Number.parseInt(
      String(pi.getFlag("inspect-port") ?? DEFAULT_CONFIG.port),
      10
    )
    try {
      await attach(ctx, { host, port })
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error"
      )
    }
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    currentContext = null
    await detach(ctx)
  })

  pi.registerCommand("inspect-attach", {
    description:
      "Attach to a Node inspector target. Usage: /inspect-attach [host:port]",
    async handler(args, ctx) {
      currentContext = ctx
      const target = parseHostPort(args, runtimeConfig)
      await attach(ctx, target)
    },
  })

  pi.registerCommand("inspect-detach", {
    description: "Detach from the current Node inspector target.",
    async handler(_args, ctx) {
      await detach(ctx, "Inspector detached.")
    },
  })

  pi.registerCommand("inspect-status", {
    description: "Show inspector connection status.",
    async handler(_args, ctx) {
      ctx.ui.notify(buildStatusText(ctx, activeConnection, state), "info")
    },
  })

  pi.registerCommand("inspect-logs", {
    description: "Show recent inspector logs. Usage: /inspect-logs [count]",
    async handler(args, ctx) {
      const count = args.trim() ? Number.parseInt(args.trim(), 10) : 20
      const lines = state
        .getRecentLogs(Number.isFinite(count) ? count : 20)
        .map((entry: ConsoleEventRecord) => `${entry.level} ${entry.text}`)
      ctx.ui.notify(
        lines.length > 0 ? lines.join("\n") : "No inspector logs buffered.",
        "info"
      )
    },
  })

  pi.registerCommand("inspect-bp", {
    description:
      "Set or browse breakpoints. Usage: /inspect-bp <file> | <file:line> [condition]",
    async handler(args, ctx) {
      const [rawValue, ...conditionParts] = args.trim().split(/\s+/)
      if (!rawValue) {
        throw new Error("Usage: /inspect-bp <file> | <file:line> [condition]")
      }
      // Strip leading '@' inserted by Pi's file autocomplete (e.g. @src/foo.ts)
      const value = rawValue.startsWith("@") ? rawValue.slice(1) : rawValue

      if (/^.*:\d+$/.test(value)) {
        const location = parseFileLineArg(value, ctx.cwd)
        const condition = conditionParts.join(" ") || undefined
        const isTypeScriptSource = location.absolutePath.endsWith(".ts")

        if (isTypeScriptSource) {
          ctx.ui.notify(
            await toggleSourceBreakpoint(ctx, value, condition),
            "info"
          )
          return
        }

        const breakpoint = await setBreakpoint(ctx, value, condition)
        ctx.ui.notify(
          `Breakpoint set: ${breakpoint.filePath}:${breakpoint.line} -> ${formatResolvedBreakpointLocation(breakpoint, ctx, state)}`,
          "info"
        )
        return
      }

      const absolutePath = resolve(ctx.cwd, value)
      if (!existsSync(absolutePath)) {
        throw new Error(`File not found: ${absolutePath}`)
      }
      const filePath = relative(ctx.cwd, absolutePath) || basename(absolutePath)
      const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/)

      await ctx.ui.custom((tui, theme, _kb, done) =>
        createSourceBreakpointViewer(tui, theme, done, {
          filePath,
          lines,
          getBreakpointState: (line) => ({
            hasBreakpoint: getSourceBreakpoints(filePath, line).length > 0,
          }),
          onToggleLine: async (line) => {
            if (absolutePath.endsWith(".ts")) {
              return toggleSourceBreakpoint(ctx, `${filePath}:${line}`)
            }

            const existing = getSourceBreakpoints(filePath, line)
            if (existing.length > 0) {
              const cleared = await removeBreakpoints(ctx, existing)
              return `Cleared ${cleared} breakpoint(s) for ${filePath}:${line}`
            }

            const breakpoint = await setBreakpoint(ctx, `${filePath}:${line}`)
            return `Breakpoint set: ${breakpoint.filePath}:${breakpoint.line} -> ${formatResolvedBreakpointLocation(breakpoint, ctx, state)}`
          },
          onClearLine: async (line) => {
            const breakpoints = getSourceBreakpoints(filePath, line)
            if (breakpoints.length === 0) {
              return `No breakpoint at ${filePath}:${line}`
            }
            const cleared = await removeBreakpoints(ctx, breakpoints)
            return `Cleared ${cleared} breakpoint(s) for ${filePath}:${line}`
          },
        })
      )
    },
  })

  pi.registerCommand("inspect-bp-list", {
    description: "List active inspector breakpoints.",
    async handler(_args, ctx) {
      ctx.ui.notify(
        buildBreakpointText(state.listBreakpoints(), ctx, state),
        "info"
      )
    },
  })

  pi.registerCommand("inspect-scripts", {
    description:
      "List loaded runtime scripts. Usage: /inspect-scripts [contains-text]",
    async handler(args, ctx) {
      ctx.ui.notify(buildScriptListText(ctx, state, args), "info")
    },
  })

  pi.registerCommand("inspect-bp-clear", {
    description: "Clear a breakpoint by id, file:line, or all.",
    async handler(args, ctx) {
      const value = args.trim()
      if (!value) {
        throw new Error("Usage: /inspect-bp-clear <id|file:line|all>")
      }
      ctx.ui.notify(await clearBreakpoint(value, ctx), "info")
    },
  })

  pi.registerCommand("inspect-resume", {
    description: "Resume execution after a pause.",
    async handler(_args, ctx) {
      if (!client) {
        throw new Error("Inspector is not attached.")
      }
      await client.send("Debugger.resume")
      state.clearPaused()
      updateUi(ctx, activeConnection, state)
    },
  })

  pi.registerCommand("inspect-step", {
    description: "Step over, in, or out. Usage: /inspect-step <over|in|out>",
    async handler(args, ctx) {
      if (!client) {
        throw new Error("Inspector is not attached.")
      }
      const kind = args.trim()
      const method =
        kind === "in"
          ? "Debugger.stepInto"
          : kind === "out"
            ? "Debugger.stepOut"
            : kind === "over"
              ? "Debugger.stepOver"
              : null
      if (!method) {
        throw new Error("Usage: /inspect-step <over|in|out>")
      }
      await client.send(method)
      updateUi(ctx, activeConnection, state)
    },
  })

  pi.registerCommand("inspect-eval", {
    description: "Evaluate an expression in the current inspector context.",
    async handler(args, ctx) {
      const expression = args.trim()
      if (!expression) {
        throw new Error("Usage: /inspect-eval <expression>")
      }
      const result = await evaluateExpression(
        expression,
        state.getPaused() ? 0 : undefined
      )
      const remote = (result.result ?? {}) as RuntimeRemoteObject
      ctx.ui.notify(formatRemoteObject(remote), "info")
    },
  })

  pi.registerTool({
    name: "inspector_status",
    label: "Inspector Status",
    description: "Get the current Node inspector connection and pause state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return {
        content: [
          { type: "text", text: buildStatusText(ctx, activeConnection, state) },
        ],
        details: {
          connected: Boolean(activeConnection),
          target: activeConnection,
          paused: state.getPaused(),
          breakpoints: state.listBreakpoints(),
          scripts: state.listScripts(),
        },
      }
    },
  })

  pi.registerTool({
    name: "inspector_recent_logs",
    label: "Inspector Recent Logs",
    description:
      "Read recent console and exception output captured from the Node inspector.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: "Number of recent log entries to return." })
      ),
      level: Type.Optional(
        Type.String({ description: "Optional exact log level filter." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const logs = state.getRecentLogs(params.limit ?? 20, params.level)
      return {
        content: [
          {
            type: "text",
            text:
              logs.length > 0
                ? logs
                    .map((entry) => `${entry.level}: ${entry.text}`)
                    .join("\n")
                : "No inspector logs buffered.",
          },
        ],
        details: { logs },
      }
    },
  })

  pi.registerTool({
    name: "inspector_get_pause",
    label: "Inspector Pause Snapshot",
    description:
      "Get the current Debugger.paused snapshot and summarized call frames.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: buildPauseDetails(ctx, state) }],
        details: { paused: state.getPaused() },
      }
    },
  })

  pi.registerTool({
    name: "inspector_scripts",
    label: "Inspector Scripts",
    description:
      "List loaded runtime scripts observed from the Node inspector.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description: "Optional substring filter for script URLs.",
        })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of scripts to return." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const limit = params.limit ?? 50
      const scripts = state
        .listScripts()
        .filter((script) => {
          if (!params.filter) {
            return true
          }
          return normalizeScriptUrl(script.url, ctx.cwd)
            .toLowerCase()
            .includes(params.filter.toLowerCase())
        })
        .slice(0, limit)
      return {
        content: [
          {
            type: "text",
            text: buildScriptListText(ctx, state, params.filter, limit),
          },
        ],
        details: { scripts },
      }
    },
  })

  pi.registerTool({
    name: "inspector_set_breakpoint",
    label: "Inspector Set Breakpoint",
    description:
      "Set a Node inspector breakpoint by file path and 1-based line number.",
    parameters: Type.Object({
      file: Type.String({
        description: "Path to the source file, relative to cwd or absolute.",
      }),
      line: Type.Number({ description: "1-based line number." }),
      condition: Type.Optional(
        Type.String({ description: "Optional breakpoint condition." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeConnection) {
        return {
          content: [{ type: "text", text: "Inspector is not attached." }],
          details: { connected: false },
        }
      }
      const breakpoint = await setBreakpoint(
        ctx,
        `${params.file}:${params.line}`,
        params.condition
      )
      return {
        content: [
          {
            type: "text",
            text: `Breakpoint set at ${breakpoint.filePath}:${breakpoint.line} -> ${formatResolvedBreakpointLocation(breakpoint, ctx, state)}`,
          },
        ],
        details: { breakpoint },
      }
    },
  })

  pi.registerTool({
    name: "inspector_remove_breakpoint",
    label: "Inspector Remove Breakpoint",
    description: "Remove an existing inspector breakpoint by breakpoint id.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "Breakpoint id returned by inspector_set_breakpoint or /inspect-bp-list.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeConnection) {
        return {
          content: [{ type: "text", text: "Inspector is not attached." }],
          details: { connected: false },
        }
      }
      const text = await clearBreakpoint(params.id, ctx)
      return { content: [{ type: "text", text }], details: { connected: true } }
    },
  })

  pi.registerTool({
    name: "inspector_resume",
    label: "Inspector Resume",
    description: "Resume the paused Node inspector target.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!client) {
        return {
          content: [{ type: "text", text: "Inspector is not attached." }],
          details: { connected: false },
        }
      }
      await client.send("Debugger.resume")
      state.clearPaused()
      updateUi(ctx, activeConnection, state)
      return {
        content: [{ type: "text", text: "Debugger resumed." }],
        details: { connected: true },
      }
    },
  })

  pi.registerTool({
    name: "inspector_step",
    label: "Inspector Step",
    description: "Step the paused Node inspector target over, in, or out.",
    parameters: Type.Object({
      kind: Type.String({ description: 'Step kind: "over", "in", or "out".' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!client) {
        return {
          content: [{ type: "text", text: "Inspector is not attached." }],
          details: { connected: false },
        }
      }
      const method =
        params.kind === "in"
          ? "Debugger.stepInto"
          : params.kind === "out"
            ? "Debugger.stepOut"
            : params.kind === "over"
              ? "Debugger.stepOver"
              : null
      if (!method) {
        return {
          content: [
            { type: "text", text: `Unsupported step kind: ${params.kind}` },
          ],
          details: { connected: true },
        }
      }
      await client.send(method)
      updateUi(ctx, activeConnection, state)
      return {
        content: [
          { type: "text", text: `Debugger ${params.kind} step requested.` },
        ],
        details: { connected: true },
      }
    },
  })

  pi.registerTool({
    name: "inspector_eval",
    label: "Inspector Evaluate",
    description:
      "Evaluate an expression against the paused call frame or the runtime global scope.",
    parameters: Type.Object({
      expression: Type.String({
        description: "JavaScript expression to evaluate.",
      }),
      frameIndex: Type.Optional(
        Type.Number({
          description: "Optional 0-based paused call frame index.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!activeConnection) {
        return {
          content: [{ type: "text", text: "Inspector is not attached." }],
          details: { connected: false },
        }
      }
      const result = await evaluateExpression(
        params.expression,
        params.frameIndex
      )
      const remote = (result.result ?? {}) as RuntimeRemoteObject
      return {
        content: [{ type: "text", text: formatRemoteObject(remote) }],
        details: { result },
      }
    },
  })
}
