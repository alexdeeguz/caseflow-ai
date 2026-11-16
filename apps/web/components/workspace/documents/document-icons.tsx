import { Icon } from '../../ui/icon';

type IconProps = { size?: number };

export function DownloadIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" />
    </Icon>
  );
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </Icon>
  );
}

export function RestoreIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7M4 4v4.7h4.7" />
    </Icon>
  );
}

export function ChevronRightIcon({ size = 16 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ArrowRightIcon({ size = 14 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </Icon>
  );
}

export function UploadIcon({ size = 18 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M12 16V5m-4.5 4.5L12 5l4.5 4.5M5 19h14" />
    </Icon>
  );
}
