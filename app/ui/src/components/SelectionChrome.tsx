import { Show, type JSX } from 'solid-js';
import type { ProfileSummary } from '../api/client';
import type { ProfileStore } from '../state/profile';
import { selectionLabel } from '../format';
import { ThreadsPanel } from './ThreadsPanel';
import { TimelineBrush } from './TimelineBrush';

/**
 * The template every specialized view shares: the selection bar on top,
 * the thread panel on the left, the timeline brush at the bottom, and the
 * view's own content in the middle. Thread and time selections both flow
 * through the store's filters, so navigating between views keeps them.
 */
export function SelectionChrome(props: {
  store: ProfileStore;
  summary: ProfileSummary;
  children: JSX.Element;
}) {
  const label = () =>
    selectionLabel(
      props.store.filters().time_range_nanos ?? null,
      props.store.filters().threads?.length ?? null,
    );

  const hasSelection = () => {
    const f = props.store.filters();
    return f.threads !== undefined || f.time_range_nanos !== undefined;
  };

  return (
    <div class="selection-chrome">
      <div class="selection-bar">
        <span>
          Selection: <strong>{label()}</strong>
        </span>
        <Show when={hasSelection()}>
          <button onClick={() => props.store.setFilters({})}>Clear selection</button>
        </Show>
      </div>
      <div class="selection-body">
        <ThreadsPanel store={props.store} summary={props.summary} />
        <div class="selection-content">{props.children}</div>
      </div>
      <TimelineBrush store={props.store} summary={props.summary} />
    </div>
  );
}
