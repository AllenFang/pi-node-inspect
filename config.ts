import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

export type InspectorRuntimeConfig = {
  host: string
  port: number
  bufferSize: number
  autoInjectPauseEvents: boolean
  ignoreLevels: string[]
}

export const DEFAULT_CONFIG: InspectorRuntimeConfig = {
  host: "127.0.0.1",
  port: 9229,
  bufferSize: 500,
  autoInjectPauseEvents: false,
  ignoreLevels: [],
}

const CONFIG_FILE_NAMES = [
  resolve(homedir(), ".pi/agent/pi-node-inspector.json"),
  resolve(process.cwd(), ".pi/pi-node-inspector.json"),
]

function parseConfigFile(filePath: string): Partial<InspectorRuntimeConfig> {
  if (!existsSync(filePath)) {
    return {}
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >
  return {
    host:
      typeof raw.host === "string" && raw.host.trim()
        ? raw.host.trim()
        : undefined,
    port: typeof raw.port === "number" ? raw.port : undefined,
    bufferSize: typeof raw.bufferSize === "number" ? raw.bufferSize : undefined,
    autoInjectPauseEvents:
      typeof raw.autoInjectPauseEvents === "boolean"
        ? raw.autoInjectPauseEvents
        : undefined,
    ignoreLevels: Array.isArray(raw.ignoreLevels)
      ? raw.ignoreLevels.filter(
          (value): value is string => typeof value === "string"
        )
      : undefined,
  }
}

export function loadInspectorConfig(
  cwd = process.cwd()
): InspectorRuntimeConfig {
  const projectFile = resolve(cwd, ".pi/pi-node-inspector.json")
  const merged: Partial<InspectorRuntimeConfig> = {}
  for (const filePath of CONFIG_FILE_NAMES.filter(
    (path) => path !== projectFile
  ).concat(projectFile)) {
    Object.assign(merged, parseConfigFile(filePath))
  }

  return {
    host: merged.host ?? DEFAULT_CONFIG.host,
    port:
      Number.isInteger(merged.port) && (merged.port ?? 0) > 0
        ? (merged.port as number)
        : DEFAULT_CONFIG.port,
    bufferSize:
      Number.isInteger(merged.bufferSize) && (merged.bufferSize ?? 0) > 0
        ? (merged.bufferSize as number)
        : DEFAULT_CONFIG.bufferSize,
    autoInjectPauseEvents:
      merged.autoInjectPauseEvents ?? DEFAULT_CONFIG.autoInjectPauseEvents,
    ignoreLevels: merged.ignoreLevels ?? DEFAULT_CONFIG.ignoreLevels,
  }
}
