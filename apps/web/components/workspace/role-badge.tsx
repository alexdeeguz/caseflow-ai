import { roleLabels, type Role } from '@caseflow/schemas';

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="rounded-full bg-canvas px-3 py-1 text-sm font-semibold text-brand">
      {roleLabels[role]}
    </span>
  );
}
