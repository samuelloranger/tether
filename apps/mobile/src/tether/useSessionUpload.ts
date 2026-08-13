import * as Haptics from 'expo-haptics';
import { notify } from '../dialog';
import { shellQuote } from '../shell';
import type { HostClient } from './hostClient';

// Native callers must pass a {uri, name, type} descriptor, not a Blob, and
// upload via expo-file-system's File.upload() rather than fetch()+FormData.
// RN's fetch(uri).blob() throws under Hermes, and FormData.append({uri})
// throws on the New Architecture. Desktop drag-drop already has a Blob.
export async function uploadSessionFile({
  client,
  sessionId,
  file,
  filename,
  sendPaste,
}: {
  client: HostClient;
  sessionId: string;
  file: Blob | { uri: string; name: string; type?: string };
  filename: string;
  sendPaste: (text: string) => void;
}): Promise<void> {
  const path = `/api/sessions/${sessionId}/upload`;
  const url = client.url(path);
  let data: { ok: boolean; path?: string; error?: string };
  if (file instanceof Blob) {
    const form = new FormData();
    form.append('file', file, filename);
    const res = await client.post(path, { body: form });
    data = (await res.json()) as { ok: boolean; path?: string; error?: string };
  } else {
    const { File, Paths, UploadType } = await import('expo-file-system');
    const source = new File(file.uri);
    const staged = new File(
      Paths.cache,
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`,
    );
    try {
      await source.copy(staged, { overwrite: true });
      const result = await staged.upload(url, {
        uploadType: UploadType.MULTIPART,
        fieldName: 'file',
        mimeType: file.type,
        parameters: { filename },
        headers: client.authHeader,
      });
      data = JSON.parse(result.body);
    } finally {
      try {
        staged.delete();
      } catch {}
    }
  }
  if (!data.ok || !data.path) throw new Error(data.error || 'upload failed');
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  sendPaste(shellQuote(data.path));
}

export async function pickAndUploadImage(
  upload: (file: { uri: string; name: string; type?: string }, filename: string) => Promise<void>,
) {
  const ImagePicker = await import('expo-image-picker');
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    void notify(
      'Permission needed',
      'Allow photo library access in Settings to attach images.',
      'error',
    );
    return;
  }
  const result = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
  if (result.canceled || !result.assets[0]) return;
  const asset = result.assets[0];
  const filename = asset.fileName || `image-${Date.now()}.jpg`;
  await upload({ uri: asset.uri, name: filename, type: asset.mimeType }, filename);
}

export function useSessionUpload({
  client,
  getActiveSessionId,
  sendPaste,
}: {
  client: HostClient;
  getActiveSessionId: () => string;
  sendPaste: (text: string) => void;
}) {
  const uploadFile = async (
    file: Blob | { uri: string; name: string; type?: string },
    filename: string,
  ) => {
    try {
      await uploadSessionFile({
        client,
        sessionId: getActiveSessionId(),
        file,
        filename,
        sendPaste,
      });
    } catch (err) {
      void notify(
        'Upload failed',
        `Could not upload the file to the server: ${String(err)}`,
        'error',
      );
    }
  };
  const pickImage = async () => {
    try {
      await pickAndUploadImage(uploadFile);
    } catch (err) {
      void notify('Upload failed', `Could not read the selected image: ${String(err)}`, 'error');
    }
  };
  return { uploadFile, pickAndUploadImage: pickImage };
}
