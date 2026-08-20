import { For } from 'solid-js';
import type { ProfileStore } from '../state/profile';
import { basename } from '../format';

/**
 * The strip of open recordings, one tab per handle, plus a trailing
 * affordance to open another. Kept decoupled from the file picker: the
 * parent supplies `onAddRecording` so this component knows nothing about
 * `Shell`.
 */
export function RecordingTabs(props: { store: ProfileStore; onAddRecording: () => void }) {
  return (
    <nav class="recording-tabs" aria-label="Open recordings">
      <ul>
        <For each={props.store.openRecordings()}>
          {(recording) => (
            <li classList={{ active: recording.handle === props.store.activeHandle() }}>
              <button
                class="recording-tab"
                classList={{ active: recording.handle === props.store.activeHandle() }}
                aria-current={recording.handle === props.store.activeHandle() ? 'page' : undefined}
                onClick={() => void props.store.selectRecording(recording.handle)}
              >
                {basename(recording.path)}
              </button>
              <button
                class="recording-tab-close"
                aria-label={`Close ${basename(recording.path)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void props.store.closeRecording(recording.handle);
                }}
              >
                ×
              </button>
            </li>
          )}
        </For>
      </ul>
      <button
        class="recording-tab-add"
        aria-label="Open another recording"
        onClick={() => props.onAddRecording()}
      >
        +
      </button>
    </nav>
  );
}
