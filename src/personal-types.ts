/**
 * Wire types for the personal-memory surface of the Mnemo API (v0.3.0):
 * people, reminders, daily brief, meetings, container timeline and memory
 * merge. Pinned to the public OpenAPI DTOs; kept deliberately loose on the
 * nested reader/citation payloads the MCP layer only forwards verbatim.
 */

import type { Memory } from './api-client.js'

/** `MemoryProvenanceDto` — server-stamped write provenance. */
export type MemoryProvenance = {
  kind: 'api_key' | 'mcp' | 'user' | 'connector' | 'inbound' | 'system'
  id: string | null
  label: string | null
}

/** `PersonImportantDateDto` */
export type PersonImportantDate = {
  label: string
  date: string
  recurring: boolean
}

/** `PersonDto` */
export type PersonRecord = {
  slug: string
  tag: string
  containerId: string
  displayName: string
  relationship: string | null
  email: string | null
  phone: string | null
  company: string | null
  notes: string | null
  importantDates: PersonImportantDate[]
  aliases: string[]
  archivedAt: string | null
  memoryCount: number
  openReminderCount: number
  nextReminderAt: string | null
  createdAt: string
  updatedAt: string
}

/** Contact fields shared by `CreatePersonDto` and `UpdatePersonDto`. `null` clears. */
export type PersonFields = {
  relationship?: string | null
  email?: string | null
  phone?: string | null
  company?: string | null
  notes?: string | null
  importantDates?: PersonImportantDate[] | null
  aliases?: string[] | null
}

export type CreatePersonInput = PersonFields & {
  displayName: string
  slug?: string
}

export type UpdatePersonInput = PersonFields & {
  displayName?: string
  archived?: boolean
}

export type ListPeopleInput = {
  q?: string
  includeArchived?: boolean
  limit?: number
  cursor?: string
}

export type ListPeopleResponse = {
  items: PersonRecord[]
  nextCursor: string | null
  total: number
}

/** `ReminderDto` = MemoryRecordDto + due/completion + owning person. */
export type ReminderRecord = Memory & {
  dueAt: string | null
  createdBy?: MemoryProvenance | null
  completedAt: string | null
  person: { slug: string; displayName: string } | null
}

export type CreateReminderInput = {
  content: string
  dueAt: string
  /** File under this person's container. Mutually exclusive with `container`. */
  personSlug?: string
  /** Any container tag; falls back to the configured default when neither target is set. */
  container?: string
  idempotencyKey?: string
  metadata?: Record<string, unknown>
}

export type UpcomingRemindersInput = {
  days?: number
  timezone?: string
  containerType?: string
  container?: string
  limit?: number
}

/** `ImportantDateDto` — an occurrence inside the requested window. */
export type ImportantDateOccurrence = {
  personSlug: string
  displayName: string
  label: string
  date: string
  daysUntil: number
  recurring: boolean
}

/** `UpcomingRemindersResponseDto` */
export type UpcomingRemindersResponse = {
  overdue: ReminderRecord[]
  dueToday: ReminderRecord[]
  upcoming: ReminderRecord[]
  importantDates: ImportantDateOccurrence[]
  generatedAt: string
  timezone: string
}

export type BriefSection = 'core' | 'followUps' | 'meetings'

export type DailyBriefInput = {
  container?: string
  date?: string
  timezone?: string
  days?: number
  sections?: BriefSection[]
}

/** `DailyBriefDto` — sections not requested (or unavailable) are null. */
export type DailyBrief = {
  date: string
  timezone: string
  generatedAt: string
  scope: { kind: 'workspace' | 'container'; containerTag: string | null }
  reminders: { overdue: ReminderRecord[]; dueToday: ReminderRecord[]; upcoming: ReminderRecord[] } | null
  importantDates: ImportantDateOccurrence[] | null
  recentMemories: Memory[] | null
  counts: { memoriesLast24h: number; documentsLast24h: number } | null
  followUps: { answer: string; citations: unknown[]; abstained: boolean; cached: boolean } | null
  meetings: MeetingRecord[] | null
}

export type TimelineItemType = 'memory' | 'reminder' | 'document' | 'event'

export type TimelineInput = {
  container?: string
  from?: string
  to?: string
  types?: TimelineItemType[]
  direction?: 'desc' | 'asc'
  limit?: number
  cursor?: string
}

/** `TimelineItemDto` */
export type TimelineItem = {
  id: string
  type: TimelineItemType
  refId: string
  occurredAt: string
  title: string
  snippet: string | null
  containerTag: string
  createdBy: MemoryProvenance | null
  meta: Record<string, unknown>
}

/** `TimelineResponseDto` */
export type TimelineResponse = {
  items: TimelineItem[]
  nextCursor: string | null
  container: { tag: string; containerType: string; displayName: string | null } | null
  range: { from: string | null; to: string | null }
}

/** `MeetingDto` */
export type MeetingRecord = {
  documentId: string
  eventId: string | null
  title: string
  start: string | null
  end: string | null
  isAllDay: boolean
  status: string | null
  htmlLink: string | null
  location: string | null
  organizer: Record<string, unknown> | null
  attendees: Array<Record<string, unknown>>
  containerTag: string
  connectionId: string | null
  attendeeSource: 'metadata' | 'contentText' | 'none'
}

export type UpcomingMeetingsInput = {
  days?: number
  limit?: number
  cursor?: string
  /** One calendar connection's container tag. */
  container?: string
}

/** `ListUpcomingMeetingsResponseDto` */
export type UpcomingMeetingsResponse = {
  items: MeetingRecord[]
  nextCursor: string | null
  connections: Array<{ id: string; containerTag: string; status: string; lastSyncAt: string | null }>
}

/** `MeetingBriefDto` */
export type MeetingBrief = MeetingRecord & {
  brief: { answer: string; citations: unknown[]; abstained: boolean; cached: boolean } | null
  people: Array<Record<string, unknown>>
  previousMeetings: Array<{ documentId: string; title: string; start: string | null }>
  generatedAt: string
}

export type MergeMemoriesInput = {
  ids: string[]
  into?: string
  content?: string
  memoryType?: string
  metadata?: Record<string, unknown>
  mergeKey?: string
  container?: string
}

/** `MergeMemoriesResponseDto` */
export type MergeMemoriesResponse = {
  memory: Memory
  mergedFromIds: string[]
  deletedIds: string[]
  replayed: boolean
}
