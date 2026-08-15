import { For, Show } from 'solid-js';
import type { ProfileStore } from '../state/profile';
import type { Shell } from '../api/shell';
import { basename, dirname, formatBytes, formatWhen } from '../format';

const OPEN_SHORTCUT = 'Ctrl+O';
const RECENT_SHORTCUT = 'Ctrl+R';

/**
 * The screen shown while no recording is open: ways to open a file, and the
 * persisted list of recent recordings, most recent first.
 */
export function WelcomeScreen(props: { store: ProfileStore; shell: Shell }) {
  let pathInput!: HTMLInputElement;

  const pick = async () => {
    const path = await props.shell.pickRecordingFile();
    if (path) await props.store.open(path);
  };

  return (
    <main class="welcome">
      <header class="welcome-header">
        <h1>katan-alysis</h1>
        <p class="tagline">JFR recording analyzer</p>
      </header>

      <div class="welcome-columns">
        <section aria-label="Start">
          <h2>Start</h2>
          <button
            class="primary"
            disabled={props.store.opening() !== undefined}
            onClick={() => void pick()}
          >
            Open a file… <kbd>{OPEN_SHORTCUT}</kbd>
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (pathInput.value) void props.store.open(pathInput.value);
            }}
          >
            <label>
              Open by path: <input ref={pathInput} type="text" name="path" />
            </label>
            <button type="submit" disabled={props.store.opening() !== undefined}>
              Open
            </button>
          </form>
          <Show
            when={props.store.opening()}
            fallback={<p class="drop-hint">…or drop a .jfr file anywhere in this window.</p>}
          >
            {(path) => (
              <p class="drop-hint opening" role="status">
                Opening {basename(path())}…
              </p>
            )}
          </Show>
        </section>

        <section aria-label="Recent">
          <h2>Recent</h2>
          <Show
            when={props.store.recents().length > 0}
            fallback={<p class="empty">No recent recordings yet.</p>}
          >
            <ul class="recents">
              <For each={props.store.recents()}>
                {(recent) => (
                  <li classList={{ missing: !recent.exists }}>
                    <button
                      class="recent-entry"
                      disabled={!recent.exists || props.store.opening() !== undefined}
                      title={
                        recent.exists
                          ? `Reopen ${recent.path} (most recent: ${RECENT_SHORTCUT})`
                          : `${recent.path} is no longer on disk`
                      }
                      onClick={() => void props.store.open(recent.path)}
                    >
                      <span class="recent-name">{basename(recent.path)}</span>
                      <span class="recent-details">
                        {dirname(recent.path)} · {formatBytes(recent.size_bytes)} ·{' '}
                        {recent.exists
                          ? formatWhen(recent.last_opened_ms, Date.now())
                          : 'file not found'}
                      </span>
                    </button>
                    <button
                      class="recent-remove"
                      aria-label={`Remove ${basename(recent.path)} from recents`}
                      onClick={() => void props.store.removeRecent(recent.path)}
                    >
                      ✕
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <button class="link" onClick={() => void props.store.clearRecents()}>
              Clear all
            </button>
          </Show>
        </section>
      </div>

      <Show when={props.store.error()}>
        <p role="alert">{props.store.error()}</p>
      </Show>
    </main>
  );
}
