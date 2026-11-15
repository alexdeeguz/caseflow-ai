export const Operation = {
  GetProfile: 'me',
  UpdateProfile: 'profile',
  ListUsers: 'users',
  UpdateRole: 'role',
  UpdateAccess: 'access',
  CreateCase: 'case.create',
  UpdateCase: 'case.update',
  ArchiveCase: 'case.archive',
  RestoreCase: 'case.restore',
  ListCases: 'cases',
  GetCase: 'case',
  AssignCase: 'assign',
  UnassignCase: 'unassign',
  ListAudit: 'audit',
} as const;

export type Operation = (typeof Operation)[keyof typeof Operation];

export const operationRequiresAdmin: Readonly<Record<Operation, boolean>> = {
  [Operation.GetProfile]: false,
  [Operation.UpdateProfile]: false,
  [Operation.ListUsers]: true,
  [Operation.UpdateRole]: true,
  [Operation.UpdateAccess]: true,
  [Operation.CreateCase]: true,
  [Operation.UpdateCase]: true,
  [Operation.ArchiveCase]: true,
  [Operation.RestoreCase]: true,
  [Operation.ListCases]: false,
  [Operation.GetCase]: false,
  [Operation.AssignCase]: true,
  [Operation.UnassignCase]: true,
  [Operation.ListAudit]: true,
};
