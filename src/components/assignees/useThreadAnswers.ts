import { useRef, useState } from "react"
import type { Attached } from "@/lib/attachments"
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
 * assignees (and whether the viewer may change them), an attachment answer
 * only the attachments (and whether the viewer may attach), and every other
 * answer sets everything else. Where no answer of its own kind applies, a
 * field comes from the read, never from another kind's answer. A late
 * answer can't undo what another change confirmed.
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
  /** For an answer to (or a read after) an upload or a removal of an attachment. */
  onAttachmentsChanged(thread: Attached): void
} {
  const [answers, setAnswers] = useState<Answers<Status>>({ thread: null, assigned: null })
  const changed = answers.thread && answers.thread.at > readStartedAt ? answers.thread.value : null
  const assigned = answers.assigned && answers.assigned.at > readStartedAt ? answers.assigned.value : null
  const attached = useAttachmentAnswers(loaded, readStartedAt, clock)
  const base = changed ?? loaded
  // what one kind of change owns comes from its own answer, else from the
  // read: never from another kind's answer, which may have been read before
  // a change of this kind landed (and so lack it, or still hold what it removed)
  const assignees = assigned ?? loaded
  const attachments = attached.thread
  const thread: ThreadDetail<Status> = {
    ...base,
    assignees: assignees.assignees,
    attachments: attachments.attachments,
    attachment_limits: attachments.attachment_limits,
    actions: { ...base.actions, assign: assignees.actions.assign, attach: attachments.actions.attach },
  }
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
    onAttachmentsChanged: attached.onAttachmentsChanged,
  }
}

/**
 * A page's thread as loaded, then as the latest answer to a change of the
 * thread itself (its status, say) on the page, over reads that started before
 * that answer arrived (the rule of `useThreadAnswers`). For a page whose
 * thread isn't in the issue's shape (a patch's), with its attachments from
 * `useAttachmentAnswers` over it.
 */
export function useChangeAnswers<T>(loaded: T, readStartedAt: number, clock: AnswerClock): { thread: T; onChanged(thread: T): void } {
  const [answer, setAnswer] = useState<Stamped<T> | null>(null)
  const changed = answer && answer.at > readStartedAt ? answer.value : null
  return {
    thread: changed ?? loaded,
    onChanged: (value) => {
      const at = ++clock.now
      setAnswer({ at, value })
    },
  }
}

/**
 * A page's thread with its attachments as the latest upload or removal on the
 * page answered, over reads that started before that answer arrived (see
 * `useThreadAnswers`, which takes its attachments from here). For a page whose
 * only change of the thread is to its attachments (a patch's).
 */
export function useAttachmentAnswers<T extends Attached>(loaded: T, readStartedAt: number, clock: AnswerClock): {
  thread: T
  /** For an answer to (or a read after) an upload or a removal of an attachment. */
  onAttachmentsChanged(thread: Attached): void
} {
  const [answer, setAnswer] = useState<Stamped<Attached> | null>(null)
  const attached = answer && answer.at > readStartedAt ? answer.value : null
  const thread: T = attached
    ? { ...loaded, attachments: attached.attachments, attachment_limits: attached.attachment_limits, actions: { ...loaded.actions, attach: attached.actions.attach } }
    : loaded
  return {
    thread,
    onAttachmentsChanged: (value) => {
      const at = ++clock.now
      setAnswer({ at, value: { attachments: value.attachments, attachment_limits: value.attachment_limits, actions: { attach: value.actions.attach } } })
    },
  }
}
