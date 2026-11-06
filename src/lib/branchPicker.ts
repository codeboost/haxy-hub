/**
 * What a branch picker sends and searches for: a branch picked from Haxy's
 * list by its exact id, or a name as typed, by the id Haxy would give it.
 */
import { displaySegment, type RefId, type RefItem } from "@/lib/repo"
import { branchId } from "@/lib/repoAdmin"

const branchPrefix = "branch:"

/** A branch id's name, percent-encoded byte for byte as Haxy sends it. */
export function encodedNameOf(id: RefId): string {
  return id.startsWith(branchPrefix) ? id.slice(branchPrefix.length) : id
}

/** The branch an id names, with its name for display. */
export function branchOf(id: RefId): RefItem {
  return { id, name: displaySegment(encodedNameOf(id)) }
}

/** Whether a name shows alike others: one that isn't UTF-8 shows its bytes as U+FFFD. */
export function showsAmbiguously(name: string): boolean {
  return name.includes("�")
}

/** What a picker sends: the branch picked, else the typed name's id, else nothing. */
export function pickedValue(text: string, picked: RefItem | null): RefId {
  if (picked !== null) return picked.id
  return text === "" ? "" : branchId(text)
}

/** What a picker searches for: every branch while one picked is shown, else names starting with the text. */
export function searchOf(text: string, picked: RefItem | null): string {
  return picked !== null ? "" : text
}

/** The key code browsers give a key the input method handles (Safari's last key of a composition included). */
const compositionKeyCode = 229

/** Whether a key belongs to an input method composing text, and so isn't the picker's to act on. */
export function composesText(key: { isComposing: boolean; keyCode: number }): boolean {
  return key.isComposing || key.keyCode === compositionKeyCode
}
