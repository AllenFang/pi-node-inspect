import { EventEmitter } from "node:events"

export type CdpRequest = {
  method: string
  params?: Record<string, unknown>
}

export type CdpResponseMessage = {
  id: number
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

export type CdpEventMessage = {
  method: string
  params?: Record<string, unknown>
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

export type InspectorClientOptions = {
  maxReconnectAttempts?: number
  reconnectBaseDelayMs?: number
  maxMessageBytes?: number
}

export class InspectorClient extends EventEmitter {
  override on(event: "connected", listener: () => void): this
  override on(
    event: "disconnected",
    listener: (event: CloseEvent | undefined) => void
  ): this
  override on(
    event: "reconnecting",
    listener: (attempt: number, delayMs: number) => void
  ): this
  override on(
    event: "notification",
    listener: (message: CdpEventMessage) => void
  ): this
  override on(event: string, listener: (...args: unknown[]) => void): this
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }
  private socket: WebSocket | null = null
  private readonly url: string
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private reconnectAttempts = 0
  private connectPromise: Promise<void> | null = null
  private intentionalClose = false
  private readonly maxReconnectAttempts: number
  private readonly reconnectBaseDelayMs: number
  private readonly maxMessageBytes: number

  constructor(url: string, options: InspectorClientOptions = {}) {
    super()
    this.url = url
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 250
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.intentionalClose = false
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.socket = socket

      socket.addEventListener("open", () => {
        this.reconnectAttempts = 0
        this.connectPromise = null
        this.emit("connected")
        resolve()
      })

      socket.addEventListener("message", (event) => {
        try {
          this.handleMessage(event.data)
        } catch (error) {
          this.rejectAllPending(error)
        }
      })

      socket.addEventListener("error", () => {
        if (socket.readyState !== WebSocket.OPEN && this.connectPromise) {
          this.connectPromise = null
          reject(new Error(`Failed to connect to inspector at ${this.url}`))
        }
      })

      socket.addEventListener("close", (closeEvent) => {
        this.socket = null
        this.connectPromise = null
        this.rejectAllPending(
          new Error(`Inspector connection closed (${closeEvent.code})`)
        )
        this.emit("disconnected", closeEvent)
        if (!this.intentionalClose && closeEvent.code === 1006) {
          void this.scheduleReconnect()
        }
      })
    })

    return this.connectPromise
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true
    const socket = this.socket
    this.socket = null
    this.connectPromise = null
    this.rejectAllPending(new Error("Inspector client disconnected"))
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "client disconnect")
    }
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Inspector socket is not open for ${method}`)
    }

    const id = this.nextId++
    const message = JSON.stringify({ id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      socket.send(message)
    })
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return
    }
    this.reconnectAttempts += 1
    const delayMs =
      this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1)
    this.emit("reconnecting", this.reconnectAttempts, delayMs)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (this.intentionalClose) {
      return
    }
    try {
      await this.connect()
    } catch {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        await this.scheduleReconnect()
      }
    }
  }

  private handleMessage(data: unknown): void {
    const text =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : String(data)
    if (Buffer.byteLength(text, "utf8") > this.maxMessageBytes) {
      throw new Error(
        `Inspector message exceeded ${this.maxMessageBytes} bytes`
      )
    }

    const payload = JSON.parse(text) as Partial<
      CdpResponseMessage & CdpEventMessage
    >
    if (typeof payload.id === "number") {
      const pending = this.pending.get(payload.id)
      if (!pending) {
        return
      }
      this.pending.delete(payload.id)
      if (payload.error) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${payload.error.message ?? "Unknown CDP error"}`
          )
        )
        return
      }
      pending.resolve(payload.result)
      return
    }

    if (payload.method) {
      this.emit("notification", {
        method: payload.method,
        params: payload.params,
      })
    }
  }

  private rejectAllPending(error: unknown): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}
