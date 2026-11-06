// The ttd mod: six tools for the agent, changed-only list context on each prompt, and /ttd.
// All logic lives in tools.ts, context.ts, launcher.ts and the shared store core (./store); this file only wires hooks.
import type { Register } from 'claude-code'
import { markSeen, readSeen, recoveryNote, renderContext, digestOf, resetSeen } from './context.ts'
import { openStore } from './mod-io.ts'
import { TOOL_SPECS, runCommand, runTool } from './tools.ts'
import type { ToolName } from './tools.ts'

type Args = Record<string, unknown>

/** The model gets one JSON text: the same payload shape on every tool. */
const answer = async ($: Parameters<typeof runTool>[0], name: ToolName, e: Args) => ({ result: JSON.stringify(await runTool($, name, e)) })

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    for (const spec of TOOL_SPECS) await $.tool.register(spec)
    await $.command.register({ name: 'ttd', description: 'Open the TTD todo window, or manage todos (list, add, start, done, rm)', argumentHint: '[list | add <title> | start|todo|done <id> | rm <id> | recover | path | op <json>]' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__ttd__list' }, ($, e) => answer($, 'list', e)).catch(() => ({ deny: 'ttd: list failed unexpectedly; the todo list was not changed by this call.' }))
  on('tool.call', { tool: 'mcp__ttd__add' }, ($, e) => answer($, 'add', e)).catch(() => ({ deny: 'ttd: add failed unexpectedly; the todo list was not changed by this call.' }))
  on('tool.call', { tool: 'mcp__ttd__update' }, ($, e) => answer($, 'update', e)).catch(() => ({ deny: 'ttd: update failed unexpectedly; the todo list was not changed by this call.' }))
  on('tool.call', { tool: 'mcp__ttd__set_status' }, ($, e) => answer($, 'set_status', e)).catch(() => ({ deny: 'ttd: set_status failed unexpectedly; the todo list was not changed by this call.' }))
  on('tool.call', { tool: 'mcp__ttd__reorder' }, ($, e) => answer($, 'reorder', e)).catch(() => ({ deny: 'ttd: reorder failed unexpectedly; the todo list was not changed by this call.' }))
  on('tool.call', { tool: 'mcp__ttd__delete' }, ($, e) => answer($, 'delete', e)).catch(() => ({ deny: 'ttd: delete failed unexpectedly; the todo list was not changed by this call.' }))

  // A new trailing context block, only when the list differs from what the model last saw (a thread's earlier rows stay fixed).
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    let block: string | undefined
    let seen: { doc: Parameters<typeof markSeen>[1]; text: string } | undefined
    try {
      const o = await openStore($)
      if (o.ok) {
        const r = await o.store.read()
        if (r.ok) {
          const last = await readSeen($)
          const text = renderContext(r.doc, { file: o.file })
          const isUnseenEmpty = last === null && r.doc.items.length === 0
          // A recovery notice rides along once; the digest is of the plain text so the next prompt is not a "change".
          const recovered = recoveryNote(r.warnings) !== undefined
          if (!isUnseenEmpty && (recovered || last === null || last.digest !== digestOf(text))) {
            block = recovered ? renderContext(r.doc, { file: o.file, warnings: r.warnings }) : text
            seen = { doc: r.doc, text }
          }
        }
      }
    } catch {
      block = undefined // a broken store never blocks the user's prompt
    }
    if (block === undefined || seen === undefined) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), block] })
    if (result.drop === undefined) {
      try {
        await markSeen($, seen.doc, seen.text)
      } catch {
        // one redundant block next time at worst
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // After a compaction or /clear the model no longer has the list.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && result.skip === undefined) {
      try {
        await resetSeen($)
      } catch {
        // see above
      }
    }
    return result
  })
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await resetSeen($)
      } catch {
        // see above
      }
    }
    return next(e)
  })

  on('command.run', { command: 'ttd' }, async ($, e) => runCommand($, e.args)).catch(() => ({
    text: 'ttd: the command failed unexpectedly; the todo file was not changed by it.',
    exitCode: 1,
  }))
}
