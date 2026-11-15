'use client';

import { useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Role, type User } from '@caseflow/schemas';

import type { AuthRequest } from '../../hooks/use-authentication';
import { createResourceClient, withResourceInvalidation } from '../../lib/resources';
import { Button } from '../ui/button';
import { RoleBadge } from './role-badge';
import { Profile } from './profile';
import { Cases } from './cases/cases';
import { Users } from './users';
import { AuditHistory } from './audit';
import { WorkspaceFrame } from './workspace-frame';
import { WorkspaceTab, tabLabels } from './navigation';
import styles from './workspace.module.css';

interface WorkspaceProps {
  user: User;
  request: AuthRequest;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export function Workspace(props: WorkspaceProps) {
  const [client] = useState(createResourceClient);
  const request = useMemo(
    () => withResourceInvalidation(client, props.request),
    [client, props.request],
  );

  // The parent remounts this boundary when the authenticated user or role changes.
  useEffect(() => () => client.clear(), [client]);

  return (
    <QueryClientProvider client={client}>
      <WorkspaceContent {...props} request={request} />
    </QueryClientProvider>
  );
}

function WorkspaceContent({ user, request, signOut, refreshProfile }: WorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>(WorkspaceTab.Cases);

  async function selectTab(nextTab: WorkspaceTab) {
    setTab(nextTab);
    await refreshProfile();
  }

  const tabs: WorkspaceTab[] =
    user.role === Role.Staff
      ? [WorkspaceTab.Cases, WorkspaceTab.Profile]
      : [WorkspaceTab.Cases, WorkspaceTab.Profile, WorkspaceTab.Users, WorkspaceTab.Audit];

  return (
    <WorkspaceFrame
      headerActions={
        <>
          <span>{user.displayName}</span>
          <RoleBadge role={user.role} />
          <Button onClick={() => void signOut()}>Sign out</Button>
        </>
      }
      navigation={
        <nav aria-label="Workspace" className={styles.nav}>
          {tabs.map((item) => (
            <button
              key={item}
              aria-current={item === tab ? 'page' : undefined}
              onClick={() => void selectTab(item)}
            >
              {tabLabels[item]}
            </button>
          ))}
        </nav>
      }
    >
      {tab === WorkspaceTab.Cases && <Cases request={request} user={user} />}
      {tab === WorkspaceTab.Profile && (
        <Profile user={user} request={request} onSaved={refreshProfile} />
      )}
      {tab === WorkspaceTab.Users && user.role !== Role.Staff && (
        <Users user={user} request={request} />
      )}
      {tab === WorkspaceTab.Audit && user.role !== Role.Staff && <AuditHistory request={request} />}
    </WorkspaceFrame>
  );
}
