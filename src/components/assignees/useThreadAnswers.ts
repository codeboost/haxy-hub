import { useState } from "react"
import type { ThreadDetail } from "@/lib/threads"

type Answers<Status extends string> = {
  /** The thread as loaded; answers to changes made before it loaded again don't apply. */
  from: ThreadDetail<Status>
  /** The latest answer to a change of the thread itself (its status, say). */
  thread: ThreadDetail<Status> | null
  /** The latest answer to a change of who is assigned. */
  assigned: Pick<ThreadDetail<Status>, "assignees" | "actions"> | null
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
 */
export function useThreadAnswers<Status extends string>(loaded: ThreadDetail<Status>): {
  thread: ThreadDetail<Status>
  /** For an answer to a change of the thread itself. */
  onChanged(thread: ThreadDetail<Status>): void
  /** For an answer to (or a read after) a change of who is assigned. */
  onAssigneesChanged(thread: ThreadDetail<Status>): void
} {
  const [answers, setAnswers] = useState<Answers<Status>>({ from: loaded, thread: null, assigned: null })
  const current = answers.from === loaded ? answers : { from: loaded, thread: null, assigned: null }
  const base = current.thread ?? loaded
  const thread = current.assigned
    ? { ...base, assignees: current.assigned.assignees, actions: { ...base.actions, assign: current.assigned.actions.assign } }
    : base
  const fresh = (previous: Answers<Status>) => (previous.from === loaded ? previous : { from: loaded, thread: null, assigned: null })
  return {
    thread,
    onChanged: (changed) => setAnswers((previous) => ({ ...fresh(previous), thread: changed })),
    onAssigneesChanged: (changed) => setAnswers((previous) => ({ ...fresh(previous), assigned: { assignees: changed.assignees, actions: changed.actions } })),
  }
}
