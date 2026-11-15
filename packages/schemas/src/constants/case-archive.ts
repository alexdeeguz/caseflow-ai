export const CaseArchiveFilter = {
  Current: 'current',
  Archived: 'archived',
  All: 'all',
} as const;

export type CaseArchiveFilter = (typeof CaseArchiveFilter)[keyof typeof CaseArchiveFilter];

export const caseArchiveLabels: Readonly<Record<CaseArchiveFilter, string>> = {
  [CaseArchiveFilter.Current]: 'Current',
  [CaseArchiveFilter.Archived]: 'Archived',
  [CaseArchiveFilter.All]: 'All',
};
