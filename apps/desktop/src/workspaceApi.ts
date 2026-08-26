import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { normalizeInvokeError } from './invokeError';
import type { WorkspaceDirListing } from './workspaceDirLogic';
import type { FileStat, FileTreeNode, FileView, Presentation } from './workspaceTypes';

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalizeInvokeError(error);
  }
}

export async function coreFileTreeBuild(files: FileStat[]): Promise<FileTreeNode[]> {
  return invoke<FileTreeNode[]>('core_file_tree_build', { files });
}

export async function coreWorkspaceDir(input: {
  hostId: string;
  sessionId: string;
  path: string;
}): Promise<WorkspaceDirListing> {
  return invoke<WorkspaceDirListing>('core_workspace_dir', {
    hostId: input.hostId,
    sessionId: input.sessionId,
    path: input.path,
  });
}

export async function coreWorkspaceFile(input: {
  hostId: string;
  sessionId: string;
  path: string;
  line?: number;
  column?: number;
}): Promise<FileView> {
  return invoke<FileView>('core_workspace_file', {
    hostId: input.hostId,
    sessionId: input.sessionId,
    path: input.path,
    line: input.line ?? null,
    column: input.column ?? null,
  });
}

export async function coreWorkspaceUpload(input: {
  hostId: string;
  sessionId: string;
  filePath: string;
}): Promise<string> {
  return invoke<string>('core_workspace_upload', {
    hostId: input.hostId,
    sessionId: input.sessionId,
    filePath: input.filePath,
  });
}

export async function corePresentationsList(hostId: string): Promise<Presentation[]> {
  return invoke<Presentation[]>('core_presentations_list', { hostId });
}

export async function corePresentationClose(hostId: string, id: string): Promise<boolean> {
  return invoke<boolean>('core_presentation_close', { hostId, id });
}
