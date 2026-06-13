import { basename, isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

export type RuntimeRemoteObject = {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  unserializableValue?: string
  preview?: {
    properties?: Array<{ name?: string; type?: string; value?: string }>
  }
}

export function normalizeScriptUrl(url?: string, cwd?: string): string {
  if (!url) {
    return "<unknown>"
  }
  if (url.startsWith("file://")) {
    const filePath = fileURLToPath(url)
    if (cwd) {
      const rel = relative(cwd, filePath)
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        return rel || basename(filePath)
      }
    }
    return filePath
  }
  return url
}

export function formatRemoteObject(value: RuntimeRemoteObject): string {
  if (value.unserializableValue) {
    return value.unserializableValue
  }
  if (value.type === "string") {
    const text = String(value.value ?? value.description ?? "")
    return text.length > 200 ? `${text.slice(0, 197)}...` : text
  }
  if (
    value.type === "number" ||
    value.type === "boolean" ||
    value.type === "bigint"
  ) {
    return String(value.value ?? value.description ?? "")
  }
  if (value.type === "undefined") {
    return "undefined"
  }
  if (value.type === "object" && value.subtype === "null") {
    return "null"
  }
  const preview = value.preview?.properties
    ?.slice(0, 4)
    .map(
      (property) =>
        `${property.name}: ${property.value ?? property.type ?? "?"}`
    )
    .join(", ")
  if (preview) {
    return `${value.description ?? value.type ?? "object"} { ${preview} }`
  }
  return value.description ?? value.type ?? "<value>"
}

export function formatConsoleText(
  args: RuntimeRemoteObject[] | undefined
): string {
  return (args ?? [])
    .map((arg) => formatRemoteObject(arg))
    .join(" ")
    .trim()
}

export function formatScriptLocation(
  frame:
    | { url?: string; lineNumber: number; columnNumber: number }
    | null
    | undefined,
  cwd: string
): string {
  if (!frame) {
    return "<unknown>"
  }
  const file = normalizeScriptUrl(frame.url, cwd)
  return `${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
}
