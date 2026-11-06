/** What grouping needs of a comment: its id, and the comment it replies to. */
export type Threaded = { id: string; parent_id: string | null }

/** A comment heading a card, with the replies beneath it (at any depth) in the same window, oldest first. */
export type CommentGroup<T extends Threaded> = { root: T; replies: T[] }

function rootOf<T extends Threaded>(comment: T, byId: ReadonlyMap<string, T>): T {
  const seen = new Set<string>()
  let current = comment
  while (current.parent_id !== null && byId.has(current.parent_id) && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId.get(current.parent_id)!
  }
  return current
}

/**
 * A window of comments, oldest first, as cards: every comment whose parent
 * isn't in the window heads one, holding the replies beneath it.
 */
export function groupReplies<T extends Threaded>(items: readonly T[]): CommentGroup<T>[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const groups = new Map<string, CommentGroup<T>>()
  for (const item of items) {
    const root = rootOf(item, byId)
    const group = groups.get(root.id) ?? { root, replies: [] }
    groups.set(root.id, root.id === item.id ? group : { root, replies: [...group.replies, item] })
  }
  return [...groups.values()]
}

/** Whether a reply in a card answers a comment other than the one heading it, so it says which. */
export function repliesElsewhere(reply: Threaded, root: Threaded): boolean {
  return reply.parent_id !== root.id
}
