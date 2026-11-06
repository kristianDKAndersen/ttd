// Contract of the ttd mod: the session state it keeps with the host.
export type TtdLastSeen = {
  /** rev of the todo list the model last saw (a prompt block or a ttd tool result) */
  rev: number
  /** digest of the exact block the model last saw; a different digest means it changed */
  digest: string
}

declare module 'claude-code' {
  interface PluginState {
    ttd: {
      /** null: the model has not seen the list in this conversation (new, cleared or compacted) */
      lastSeen: TtdLastSeen | null
    }
  }
}
