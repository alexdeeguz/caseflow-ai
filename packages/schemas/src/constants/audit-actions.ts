export const AuditAction = {
  FactExtractionQueued: 'document.facts_queued',
  FactExtractionCompleted: 'document.facts_completed',
  FactExtractionFailed: 'document.facts_failed',
  FactExtractionCancelled: 'document.facts_cancelled',
  FactExtractionRecovered: 'document.facts_recovered',
  DocumentUploadStarted: 'document.upload_started',
  DocumentProcessingQueued: 'document.processing_queued',
  DocumentProcessingRecovered: 'document.processing_recovered',
  DocumentProcessingCompleted: 'document.processing_completed',
  DocumentProcessingFailed: 'document.processing_failed',
  DocumentProcessingCancelled: 'document.processing_cancelled',
  DocumentUploaded: 'document.uploaded',
  DocumentRemoved: 'document.removed',
  DocumentRestored: 'document.restored',
  DocumentDownloadAuthorized: 'document.download_authorized',

  CaseCreated: 'case.created',
  CaseUpdated: 'case.updated',
  CaseArchived: 'case.archived',
  CaseRestored: 'case.restored',
  ProfileUpdated: 'profile.updated',
  UserRoleChanged: 'user.role_changed',
  UserAccessChanged: 'user.access_changed',
  CaseAssignmentChanged: 'case.assignment_changed',
  OperatorRoleChanged: 'operator.role_changed',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
