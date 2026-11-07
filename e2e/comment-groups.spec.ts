import { expect, test } from "@playwright/test"
import { groupReplies } from "../src/lib/commentGroups"

// How a window of comments, oldest first, is grouped into cards: each
// comment whose parent isn't in the window heads a card holding every reply
// beneath it (at any depth) that the window has.

const comment = (id: string, parent_id: string | null = null) => ({ id, parent_id })
const ids = (groups: ReturnType<typeof groupReplies<{ id: string; parent_id: string | null }>>) =>
  groups.map(({ root, replies }) => [root.id, replies.map((reply) => reply.id)])

test("comments on the thread each head their own card, in window order", () => {
  expect(ids(groupReplies([comment("a"), comment("b"), comment("c")]))).toEqual([["a", []], ["b", []], ["c", []]])
})

test("replies at any depth go into their top comment's card, oldest first", () => {
  const window = [comment("a"), comment("b"), comment("a1", "a"), comment("a1x", "a1"), comment("b1", "b"), comment("a2", "a")]
  expect(ids(groupReplies(window))).toEqual([["a", ["a1", "a1x", "a2"]], ["b", ["b1"]]])
})

test("a reply whose parent is outside the window heads a card of its own, holding its replies", () => {
  const window = [comment("r", "earlier"), comment("r1", "r"), comment("s", "earlier")]
  expect(ids(groupReplies(window))).toEqual([["r", ["r1"]], ["s", []]])
})

test("the comments passed in are left as they were", () => {
  const window = Object.freeze([comment("a"), comment("a1", "a")])
  groupReplies(window)
  expect(window.map((item) => item.id)).toEqual(["a", "a1"])
})
