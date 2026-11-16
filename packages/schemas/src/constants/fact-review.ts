export const FactReviewStatus = {
  Unreviewed: 'unreviewed',
  Approved: 'approved',
  Rejected: 'rejected',
} as const;

export type FactReviewStatus = (typeof FactReviewStatus)[keyof typeof FactReviewStatus];

export const factReviewStatusLabels: Record<FactReviewStatus, string> = {
  unreviewed: 'Unreviewed',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const FactReviewAction = {
  Correct: 'correct',
  Approve: 'approve',
  Reject: 'reject',
  Reopen: 'reopen',
} as const;

export type FactReviewAction = (typeof FactReviewAction)[keyof typeof FactReviewAction];

export const FactReviewLimits = { ReasonLength: 1000 } as const;

export const factReviewActionLabels: Record<FactReviewAction, string> = {
  correct: 'Corrected',
  approve: 'Approved',
  reject: 'Rejected',
  reopen: 'Reopened',
};
