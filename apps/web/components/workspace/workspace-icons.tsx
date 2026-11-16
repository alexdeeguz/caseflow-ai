import { Icon } from '../ui/icon';

export { CloseIcon } from '../ui/icon';

export function CasesIcon() {
  return (
    <Icon>
      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="M3 9h18" />
    </Icon>
  );
}

export function ProfileIcon() {
  return (
    <Icon>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" />
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3" />
      <path d="M2 21v-2a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v2M16 5a3 3 0 0 1 0 6m3 3a5 5 0 0 1 3 5v2" />
    </Icon>
  );
}

export function AuditIcon() {
  return (
    <Icon>
      <path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V10l-7-7Z" />
      <path d="M14 3v7h7M7 14h10M7 17h7" />
    </Icon>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icon>
  );
}

export function SignOutIcon() {
  return (
    <Icon>
      <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M9 12h12m-4-4 4 4-4 4" />
    </Icon>
  );
}

export function ArrowLeftIcon() {
  return (
    <Icon size={16}>
      <path d="M19 12H5m6-6-6 6 6 6" />
    </Icon>
  );
}
