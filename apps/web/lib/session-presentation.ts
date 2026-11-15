const workspaceShellKey = 'caseflow:workspace-shell';

// Presentation only: this hint never establishes identity or authorizes API access.
export const sessionPresentationScript = `
try {
  document.documentElement.dataset.workspaceShell =
    sessionStorage.getItem(${JSON.stringify(workspaceShellKey)}) === '1' ? 'true' : 'false';
} catch {}
`;

export function rememberWorkspaceShell(showWorkspace: boolean) {
  try {
    if (showWorkspace) {
      sessionStorage.setItem(workspaceShellKey, '1');
    } else {
      sessionStorage.removeItem(workspaceShellKey);
    }
  } catch {
    // Storage can be unavailable; session restoration must still run normally.
  }
}
