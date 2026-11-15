export const Operation = {
  GetProfile: 'me',
  UpdateProfile: 'profile',
  ListUsers: 'users',
  UpdateRole: 'role',
  UpdateAccess: 'access',
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
  [Operation.ListCases]: false,
  [Operation.GetCase]: false,
  [Operation.AssignCase]: true,
  [Operation.UnassignCase]: true,
  [Operation.ListAudit]: true,
};
