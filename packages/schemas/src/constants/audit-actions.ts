export const AuditAction = {
  ProfileUpdated: 'profile.updated',
  UserRoleChanged: 'user.role_changed',
  UserAccessChanged: 'user.access_changed',
  CaseAssignmentChanged: 'case.assignment_changed',
  OperatorRoleChanged: 'operator.role_changed',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
