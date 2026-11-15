export const Role = {
  Staff: 'staff',
  Admin: 'admin',
  SuperAdmin: 'super_admin',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const roleLabels: Readonly<Record<Role, string>> = {
  [Role.Staff]: 'Staff',
  [Role.Admin]: 'Admin',
  [Role.SuperAdmin]: 'Super Admin',
};
