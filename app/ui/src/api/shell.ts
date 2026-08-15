// Desktop-shell interactions (native dialog, drag-and-drop). Kept behind an
// interface so components take an injectable `Shell` and tests never touch
// the Tauri runtime.
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';

export interface Shell {
  /** Native file picker, `.jfr` filtered; `null` when the analyst cancels. */
  pickRecordingFile(): Promise<string | null>;
  /** Calls `handler` with the path of a file dropped anywhere on the window. */
  onFileDrop(handler: (path: string) => void): Promise<() => void>;
}

export const tauriShell: Shell = {
  async pickRecordingFile() {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'JFR recordings', extensions: ['jfr'] }],
    });
    return typeof picked === 'string' ? picked : null;
  },

  onFileDrop(handler) {
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
        handler(event.payload.paths[0]);
      }
    });
  },
};
