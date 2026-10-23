// OpenCode (v2) подставляет `@opencode/plugin` во время загрузки плагина,
// поэтому пакета нет в node_modules и его тип не резолвится через tsc.
// Объявляем минимальный тип только для используемых методов.

declare module "@opencode/plugin" {
  export interface IssueGenerationResult {
    text: string
  }

  export interface PluginContext {
    /** Каталог текущего проекта. */
    location: { directory: string; workspaceID?: string; project?: { id: string; directory: string } }
    /** Генерация текста моделью (дубликаты/перевод). */
    generate: { text(input: { model?: { providerID: string; id: string }; prompt: string }): Promise<IssueGenerationResult> }
    /** Запрос разрешения у пользователя. */
    permission: { assert(input: Record<string, unknown>): Promise<void> }
    /** Регистрация инструментов. */
    tool: { transform(cb: (editor: ToolEditor) => void | Promise<void>): Promise<void> }
    [key: string]: any
  }

  export interface PluginToolContext {
    sessionID: string
    agent: string
    messageID: string
    id: string
    [key: string]: any
  }

  export interface PluginToolResult {
    content: string
    metadata?: Record<string, unknown>
  }

  export interface PluginTool {
    name: string
    description: string
    /** JSON Schema параметров инструмента. */
    input: Record<string, unknown>
    execute(args: any, context: PluginToolContext): Promise<PluginToolResult>
  }

  export interface ToolEditor {
    list(): Array<{ name: string; [key: string]: unknown }>
    get(id: string): unknown
    namespace(value: string): ToolEditor
    add(tool: PluginTool): unknown
    update(id: string, tool: Partial<PluginTool>): unknown
    remove(id: string): unknown
  }

  export interface PluginDefinition {
    id: string
    setup(ctx: PluginContext): void | Promise<void>
  }

  export const Plugin: {
    define<T extends PluginDefinition>(definition: T): T
  }
}
