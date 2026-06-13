export type InspectorDiscoveryOptions = {
  host: string
  port: number
  targetId?: string
}

export type InspectorTarget = {
  description?: string
  devtoolsFrontendUrl?: string
  faviconUrl?: string
  id: string
  title?: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

export type DiscoveredInspectorTarget = {
  endpoint: string
  target: InspectorTarget
  webSocketDebuggerUrl: string
}

function normalizeHost(host: string): string {
  return host.trim() || "127.0.0.1"
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid inspector port: ${port}`)
  }
  return port
}

export async function discoverInspectorTarget(
  options: InspectorDiscoveryOptions
): Promise<DiscoveredInspectorTarget> {
  const host = normalizeHost(options.host)
  const port = normalizePort(options.port)
  const endpoint = `http://${host}:${port}/json/list`
  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
  })

  if (!response.ok) {
    throw new Error(
      `Inspector discovery failed (${response.status} ${response.statusText}) at ${endpoint}`
    )
  }

  const payload = (await response.json()) as unknown
  if (!Array.isArray(payload)) {
    throw new Error(
      `Inspector discovery returned a non-array payload from ${endpoint}`
    )
  }

  const targets = payload as InspectorTarget[]
  if (targets.length === 0) {
    throw new Error(`No inspector targets found at ${endpoint}`)
  }

  const target = options.targetId
    ? targets.find((item) => item.id === options.targetId)
    : (targets.find((item) => item.type === "node") ?? targets[0])

  if (!target) {
    throw new Error(
      options.targetId
        ? `Inspector target ${options.targetId} was not found at ${endpoint}`
        : `No matching inspector target found at ${endpoint}`
    )
  }

  if (!target.webSocketDebuggerUrl) {
    throw new Error(
      `Inspector target ${target.id} does not expose webSocketDebuggerUrl`
    )
  }

  return {
    endpoint,
    target,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  }
}
