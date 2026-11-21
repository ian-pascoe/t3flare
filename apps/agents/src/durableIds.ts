// pi-durable's ids (conversations, entries, submissions) are branded numbers. t3flare keeps them as plain numbers in
// storage and as decimal strings in the session protocol (`TurnState`), so the brand is put back here, in one place.
import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";

/** pi-durable's id of conversation `stored` (a number, or the decimal string the protocol keeps it as). */
// SAFETY: every stored value was read from a `ConversationId` (`Number(conversation.id)`, `String(target.id)`) or
// parsed from digits that `entryRef` / `noteRef` wrote from one; a brand has no runtime form to check.
export const conversationIdOf = (stored: number | string): ConversationId => Number(stored) as ConversationId;

/** pi-durable's id of entry `stored` (a number, or the decimal string the protocol keeps it as). */
// SAFETY: as `conversationIdOf`: stored values come from an `EntryId` (or, for `last + 1` and `boundary - 1`, an
// entry's neighbour, which pi-durable's range bounds accept whether or not an entry exists there).
export const entryIdOf = (stored: number | string): EntryId => Number(stored) as EntryId;

/** pi-durable's id of submission `stored` (a turn's `submissionId`, a decimal string). */
// SAFETY: as `conversationIdOf`: a turn's `submissionId` is `String(submission.id)`.
export const submissionIdOf = (stored: number | string): SubmissionId => Number(stored) as SubmissionId;
