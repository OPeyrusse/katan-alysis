import { For } from 'solid-js';
import type { ProfileSummary } from '../api/client';
import { VIEWS, type ProfileStore } from '../state/profile';
import { formatSeconds } from '../format';

/** Navigation between views plus the loaded recording's vitals. */
export function Sidebar(props: { store: ProfileStore; summary: ProfileSummary }) {
  return (
    <aside class="sidebar">
      <nav aria-label="Views">
        <ul>
          <For each={VIEWS}>
            {(view) => (
              <li>
                <button
                  class="nav-entry"
                  classList={{ active: props.store.activeView() === view.id }}
                  disabled={!view.ready}
                  title={view.ready ? undefined : 'Not built yet'}
                  aria-current={props.store.activeView() === view.id ? 'page' : undefined}
                  onClick={() => props.store.setActiveView(view.id)}
                >
                  {view.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      </nav>

      <dl class="recording-facts" aria-label="Recording">
        <dt>Duration</dt>
        <dd>{formatSeconds(props.summary.duration_nanos)}</dd>
        <dt>Samples</dt>
        <dd>{props.summary.sample_count.toLocaleString('en-US')}</dd>
        <dt>Threads</dt>
        <dd>{props.summary.threads.length}</dd>
      </dl>
    </aside>
  );
}
