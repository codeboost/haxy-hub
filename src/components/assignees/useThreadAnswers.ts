import { useRef, useState } from "react"
import type { ThreadDetail } from "@/lib/threads"

/**
 * A page's clock for ordering its reads of a thread against the answers to
 * its own changes: a read notes the time it started, and an answer the time it
 * arrived. One clock per page; it only ever counts up.
 */
export type AnswerClock = { now: number }

export function useAnswerClock(): AnswerClock {
  return useRef<AnswerClock>({ now: 0 }).current
}

type Stamped<T> = { at: number; value: T }

type Answers<Status extends string> = {
  /** The latest answer to a change of the thread itself (its status, say). */
  thread: Stamped<ThreadDetail<Status>> | null
  /** The latest answer to a change of who is assigned. */
  assigned: Stamped<Pick<ThreadDetail<Status>, "assignees" | "actions">> | null
}

/**
 * The thread a page shows: as loaded, then as each change on it answered.
 *
 * The thread's own actions (close, reopen) and its assignee controls write
 * independently, and each answer is a whole thread read after its write.
 * Answers can cross: one write's answer may arrive after another write that
 * landed later, carrying that write's field as it was before. So each kind
 * of change owns what it changes. An assignee answer sets only the
 * assignees (and whether the viewer may change them), and every other answer
 * sets everything else. A late answer can't undo what another change
 * confirmed.
 *
 * The page also reads the thread again in the background, and such a read
 * may have started before a change answered (so it may not hold the change)
 * yet land after it. An answer therefore stands over every read that started
 * before it arrived (`readStartedAt`, on `clock`), and gives way to a read
 * that started after it, which already holds it.
 */
export function useThreadAnswers<Status extends string>(loaded: ThreadDetail<Status>, readStartedAt: number, clock: AnswerClock): {
  thread: ThreadDetail<Status>
  /** For an answer to a change of the thread itself. */
  onChanged(thread: ThreadDetail<Status>): void
  /** For an answer to (or a read after) a change of who is assigned. */
  onAssigneesChanged(thread: ThreadDetail<Status>): void
} {
  const [answers, setAnswers] = useState<Answers<Status>>({ thread: null, assigned: null })
  const changed = answers.thread && answers.thread.at > readStartedAt ? answers.thread.value : null
  const assigned = answers.assigned && answers.assigned.at > readStartedAt ? answers.assigned.value : null
  const base = changed ?? loaded
  const thread = assigned
    ? { ...base, assignees: assigned.assignees, actions: { ...base.actions, assign: assigned.actions.assign } }
    : base
  return {
    thread,
    onChanged: (value) => {
      const at = ++clock.now
      setAnswers((previous) => ({ ...previous, thread: { at, value } }))
    },
    onAssigneesChanged: (value) => {
      const at = ++clock.now
      setAnswers((previous) => ({ ...previous, assigned: { at, value: { assignees: value.assignees, actions: value.actions } } }))
    },
  }
}
