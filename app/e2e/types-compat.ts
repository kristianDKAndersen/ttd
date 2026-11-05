// E8: compile-time proof that the UI's mirrored types (app/src/types.ts) and the store core's types
// (plugin/hooks/store/types.ts) describe the same data. Checked by `bun run typecheck`; never executed.
// The core's Doc/Item carry an `[unknown: string]: unknown` index signature (unknown fields are preserved on
// read-modify-write); the UI mirror deliberately omits it, so structural comparison goes through `Known<T>`,
// which drops index signatures and keeps the declared keys.
import type * as Ui from "../src/types.ts"
import type * as Core from "../../plugin/hooks/store/index.ts"

type Known<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] }

// A document with the index signatures removed at both levels.
type KnownDoc<D extends { items: unknown[] }, I> = Omit<Known<D>, "items"> & { items: Known<I>[] }
type CoreKnownDoc = KnownDoc<Core.Doc, Core.Item>

// Mutual assignability, written as a type-level check that fails the build when either direction breaks.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const same = <_T extends true>(): void => {}

// ---- UI -> core and core -> UI, by direct assignment (the way real values flow through the shim) -------------
declare const uiDoc: Ui.Doc
declare const uiItem: Ui.Item
declare const uiOp: Ui.Op
declare const coreDoc: Core.Doc
declare const coreItem: Core.Item
declare const coreOp: Core.Op
declare const coreApply: Core.ApplyResult
declare const coreRead: Core.ReadResult
declare const uiApply: Ui.ApplyResult
declare const uiRead: Ui.ReadResult

// An op built by the UI is accepted by the core, and the core's Op is a valid UI Op.
export const opToCore: Core.Op = uiOp
export const opToUi: Ui.Op = coreOp

// Core documents are valid UI documents (what the shim sends); UI documents are valid core input once the
// open index signature is ignored.
export const docToUi: Ui.Doc = coreDoc
export const itemToUi: Ui.Item = coreItem
export const docToCore: CoreKnownDoc = uiDoc
export const itemToCore: Known<Core.Item> = uiItem

// Envelopes the shim returns are accepted by the UI backend types.
export const applyToUi: Ui.ApplyResult = coreApply
export const readToUi: Ui.ReadResult = coreRead
// ... and the UI's error codes are exactly the core's.
export const codeToCore: Core.ErrorCode = (undefined as unknown as Ui.ErrorCode)
export const codeToUi: Ui.ErrorCode = (undefined as unknown as Core.ErrorCode)
export const statusToCore: Core.Status = (undefined as unknown as Ui.Status)
export const statusToUi: Ui.Status = (undefined as unknown as Core.Status)

// ---- exact structural equality of the declared parts ---------------------------------------------------------
same<Equal<Known<Ui.Item>, Known<Core.Item>>>()
same<Equal<KnownDoc<Ui.Doc, Ui.Item>, CoreKnownDoc>>()
same<Equal<Ui.Op, Core.Op>>()
same<Equal<Ui.ErrorCode, Core.ErrorCode>>()
same<Equal<Ui.Status, Core.Status>>()

// Keep the unused-declaration lint quiet without executing anything.
export type _Unused = [typeof uiApply, typeof uiRead]
