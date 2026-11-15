export const AuditAction = {
  DocumentUploadStarted: 'document.upload_started',
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
