export interface ModelRef {
  provider: string
  id: string
  name?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
}

export interface ScopedModel {
  model: ModelRef
  thinkingLevel?: string
}

export interface ExtensionContext {
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  model?: ModelRef
  scopedModels: readonly ScopedModel[]
  isIdle(): boolean
  hasPendingMessages(): boolean
  abort(): void
  signal?: AbortSignal
  modelRegistry: {
    refresh(): Promise<unknown>
    getAvailable(): ModelRef[]
  }
  ui: {
    theme?: { fg(kind: string, text: string): string }
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
    setStatus(key: string, text: string | undefined): void
    setWorkingMessage(message?: string): void
    select?(title: string, options: string[]): Promise<string | undefined>
    confirm?(title: string, message: string): Promise<boolean>
  }
}

export interface ExtensionAPI {
  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void
  registerCommand(name: string, options: {
    description: string
    handler: (args: string, ctx: ExtensionContext) => Promise<void> | void
  }): void
  sendUserMessage(content: string | Array<Record<string, unknown>>): void
  /**
   * 追加一条不参与 LLM 上下文的 custom entry。
   * appendEntry 会向 session.subscribe 流发出 entry_appended 事件，
   * 从而触发 TUI footer/界面重绘——用于切换模型后强制底栏同步显示新模型名。
   */
  appendEntry?(customType: string, data: Record<string, unknown>): void
  setModel(model: ModelRef): Promise<boolean>
  setThinkingLevel?(level: string): void
}

export type FailureClass =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'endpoint'
  | 'timeout'
  | 'model_config'
  | 'content_policy'
  | 'context_overflow'
  | 'unknown'

export type HealthScope = 'model' | 'provider' | 'endpoint'

export interface FailureObservation {
  message?: string
  status?: number
  retryAfterMs?: number
  watchdog?: boolean
  aborted?: boolean
  rawStopReason?: string
}
