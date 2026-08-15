import { For, Show } from 'solid-js';
import type { ProfileStore } from '../state/profile';
import type { Shell } from '../api/shell';
import { basename, dirname, formatBytes, formatWhen } from '../format';

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
          <button class="primary" onClick={() => void pick()}>
            Open a file…
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
            <button type="submit">Open</button>
          </form>
          <p class="drop-hint">…or drop a .jfr file anywhere in this window.</p>
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
                  <li>
                    <button
                      class="recent-entry"
                      onClick={() => void props.store.open(recent.path)}
                    >
                      <span class="recent-name">{basename(recent.path)}</span>
                      <span class="recent-details">
                        {dirname(recent.path)} · {formatBytes(recent.size_bytes)} ·{' '}
                        {formatWhen(recent.last_opened_ms, Date.now())}
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
