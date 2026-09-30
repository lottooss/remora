// Fixture for scripts/check-no-stubs.test.mjs — covers every stub pattern from
// docs/tasks/P7-G3.md. Test data only: never imported and never type-checked.

// TODO comment marker
// FIXME comment marker
// XXX comment marker

export const doubleQuoted = "unlock (placeholder)"
export const singleQuoted = 'placeholder text'
export const context = (ctx as any).typertGateway
export const untyped = ctx as unknown as { on(event: string): () => void }
export const koffi = globalThis.koffi
export const koffiUntyped = (globalThis as unknown as { koffi?: unknown }).koffi
export const lazy = (): never => {
  throw new Error('not implemented')
}

// Negative: the word placeholder in a comment is not a string literal.
// Negative: a backtick template is outside the "..." and '...' scope of the packet.
export const template = `placeholder in a backtick is out of scope`
