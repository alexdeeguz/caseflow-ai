export const FactExtractionStatus = {
  NotExtracted: 'not_extracted',
  Queued: 'queued',
  Extracting: 'extracting',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type FactExtractionStatus = (typeof FactExtractionStatus)[keyof typeof FactExtractionStatus];

export const FactCategory = {
  Date: 'date',
  Provider: 'provider',
  Treatment: 'treatment',
  Finding: 'finding',
} as const;

export type FactCategory = (typeof FactCategory)[keyof typeof FactCategory];

export const factCategoryLabels: Readonly<Record<FactCategory, string>> = {
  date: 'Dates',
  provider: 'Providers',
  treatment: 'Treatments',
  finding: 'Findings',
};

export const FactExtractionFailure = {
  SourceUnavailable: 'source_unavailable',
  LimitExceeded: 'limit_exceeded',
  InvalidEvidence: 'invalid_evidence',
  ProviderRefused: 'provider_refused',
  IncompleteResponse: 'incomplete_response',
  ProviderUnavailable: 'provider_unavailable',
  BudgetExceeded: 'budget_exceeded',
  AttemptsExhausted: 'attempts_exhausted',
  InternalError: 'internal_error',
} as const;

export type FactExtractionFailure =
  (typeof FactExtractionFailure)[keyof typeof FactExtractionFailure];

export const factExtractionFailureMessages: Readonly<Record<FactExtractionFailure, string>> = {
  source_unavailable: 'The saved document text could not be verified. Try again later.',
  limit_exceeded: 'This document exceeds the fact extraction limits.',
  invalid_evidence: 'The extracted information could not be matched reliably to its source.',
  provider_refused: 'The AI service declined this extraction request.',
  incomplete_response: 'The AI service returned incomplete results. No facts were published.',
  provider_unavailable: 'The AI service is temporarily unavailable. Try again later.',
  budget_exceeded:
    'The daily fact extraction allowance has been reached. Retry on a later UTC day.',
  attempts_exhausted: 'Fact extraction could not finish within its retry limit.',
  internal_error: 'Fact extraction could not finish. Try again later.',
};

export const FactExtractionLimits = {
  Model: 'gpt-5.4-mini-2026-03-17',
  PromptVersion: '1',
  SchemaVersion: 1,
  MaxInputTokens: 12000,
  MaxOutputTokens: 8192,
  MaxChunks: 64,
  MaxProviderAttempts: 3,
  DailyAllowanceNanodollars: 1000000000,
} as const;
