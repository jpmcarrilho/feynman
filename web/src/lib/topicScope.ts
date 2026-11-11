/**
 * What a session started from the Create Session dialog will draw from, decided in one place so the start button and the
 * text above it always agree:
 *  - topics ticked one by one: exactly those;
 *  - nothing ticked but a filter or search is set: the topics those filters match (never more);
 *  - nothing ticked and no filter: every topic shown, sent as an empty list ("the whole scope" on the server).
 */
export interface TopicScopeInput {
  selectedIds: string[]
  /** Ids of the topics matched by the course/week/class/unit filters and the search text. */
  matchedIds: string[]
  /** Human labels of the filters in effect (course codes, modules, classes, units, search text). */
  filterLabels: string[]
  /** Course codes of the topics shown (used when no filter is set). */
  shownCourseCodes: string[]
}

export interface TopicScope {
  kind: 'selected' | 'filtered' | 'all' | 'none'
  /** The ids to pass to the server; empty for 'all' (and 'none', which cannot start). */
  topicIds: string[]
  /** One sentence for the student. */
  summary: string
  canStart: boolean
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function resolveTopicScope({ selectedIds, matchedIds, filterLabels, shownCourseCodes }: TopicScopeInput): TopicScope {
  if (selectedIds.length > 0) {
    return { kind: 'selected', topicIds: selectedIds, summary: `${plural(selectedIds.length, 'selected topic')} will be used.`, canStart: true }
  }
  if (filterLabels.length > 0) {
    if (matchedIds.length === 0) {
      return { kind: 'none', topicIds: [], summary: 'No topic matches the filters, so no session can start.', canStart: false }
    }
    return {
      kind: 'filtered',
      topicIds: matchedIds,
      summary: `${plural(matchedIds.length, 'topic')} matching ${filterLabels.join(', ')} will be used.`,
      canStart: true,
    }
  }
  const courses = shownCourseCodes.length > 0 ? shownCourseCodes.join(', ') : 'the course'
  return { kind: 'all', topicIds: [], summary: `All topics of ${courses} will be used.`, canStart: true }
}
