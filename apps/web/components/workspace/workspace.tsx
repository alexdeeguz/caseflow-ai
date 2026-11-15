'use client';

import { useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Role, type User } from '@caseflow/schemas';

import type { AuthRequest } from '../../hooks/use-authentication';
import { createResourceClient, withResourceInvalidation } from '../../lib/resources';
import { createUploadQueue, withUploadAccessChecks } from '../../lib/documents/upload-queue';
import { browserUploadTransport } from '../../lib/documents/upload-transport';
import { UploadProvider } from './documents/upload-provider';
import { UploadQueuePanel } from './documents/upload-queue-panel';
import { RoleBadge } from './role-badge';
import { Profile } from './profile';
import { Cases } from './cases/cases';
import { Users } from './users';
import { AuditHistory } from './audit';
import { WorkspaceFrame } from './workspace-frame';
import { WorkspaceNavigation } from './workspace-navigation';
import { SignOutIcon } from './workspace-icons';
import { WorkspaceTab, tabLabels } from './navigation';
import { useWorkspaceNavigation } from '../../hooks/use-workspace-navigation';
import { ToastProvider } from '../ui/toast-provider';
import { StatusMessage } from '../ui/status-message';
import { CaseDraftProvider } from './cases/case-draft-provider';
import { createCaseDraftStore, withDraftAccessChecks } from '../../lib/case-drafts';
import styles from './workspace.module.css';

interface WorkspaceProps {
  user: User;
  request: AuthRequest;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export function Workspace(props: WorkspaceProps) {
  const [client] = useState(createResourceClient);
  const [drafts] = useState(createCaseDraftStore);
  const [uploads] = useState(() => createUploadQueue(props.request, browserUploadTransport));
  const request = useMemo(
    () =>
      withResourceInvalidation(
        client,
        withUploadAccessChecks(withDraftAccessChecks(props.request, drafts), uploads),
      ),
    [client, props.request, drafts, uploads],
  );

  useEffect(() => uploads.setRequest(request), [uploads, request]);

  // The parent remounts this boundary when the authenticated user or role changes.
  useEffect(() => () => client.clear(), [client]);

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UploadProvider store={uploads}>
          <CaseDraftProvider store={drafts}>
            <WorkspaceContent
              {...props}
              request={request}
              signOut={() => {
                uploads.clear();
                drafts.clear();
                return props.signOut();
              }}
            />
          </CaseDraftProvider>
        </UploadProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function WorkspaceContent({ user, request, signOut, refreshProfile }: WorkspaceProps) {
  const { location, pending, navigate } = useWorkspaceNavigation(
    request,
    refreshProfile,
    user.role,
  );
  const tab = location.tab;
  const pendingTab = pending?.tab ?? null;

  const selectTab = (nextTab: WorkspaceTab) =>
    navigate({ ...location, tab: nextTab, case: null, mode: undefined });

  return (
    <WorkspaceFrame
      busy={pendingTab !== null}
      account={
        <>
          <div className={styles.accountDetails}>
            <span className={styles.accountName}>{user.displayName}</span>
            <RoleBadge role={user.role} />
          </div>
          <button type="button" className={styles.signOut} onClick={() => void signOut()}>
            <SignOutIcon />
            <span>Sign out</span>
          </button>
        </>
      }
      navigation={(closeNavigation) => (
        <WorkspaceNavigation
          role={user.role}
          currentTab={tab}
          pendingTab={pendingTab}
          onSelect={(nextTab) => {
            closeNavigation();
            void selectTab(nextTab);
          }}
        />
      )}
    >
      <UploadQueuePanel />
      <span role="status" className="sr-only">
        {pendingTab ? `Opening ${tabLabels[pendingTab]}…` : ''}
      </span>
      {tab === WorkspaceTab.Cases && (
        <Cases
          request={request}
          user={user}
          location={location}
          navigate={navigate}
          pendingLocation={pending?.tab === WorkspaceTab.Cases ? pending : null}
        />
      )}
      {user.role === Role.Staff && (tab === WorkspaceTab.Users || tab === WorkspaceTab.Audit) && (
        <StatusMessage tone="error">You do not have permission to view this page.</StatusMessage>
      )}
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
