export const CaseStatus = {
  Intake: 'intake',
  Active: 'active',
  Closed: 'closed',
} as const;

export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

export const caseStatusLabels: Readonly<Record<CaseStatus, string>> = {
  [CaseStatus.Intake]: 'Intake',
  [CaseStatus.Active]: 'Active',
  [CaseStatus.Closed]: 'Closed',
};

export const CaseLimits = {
  Title: 200,
  ClientName: 100,
  Summary: 2000,
  Search: 200,
} as const;
