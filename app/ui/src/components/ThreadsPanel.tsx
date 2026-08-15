import { For, createMemo, createSignal } from 'solid-js';
import type { ProfileSummary } from '../api/client';
import type { ProfileStore } from '../state/profile';

/**
 * Thread selection, ordered by whole-recording activity so entries do not
 * jump around while the analyst filters. An empty selection is sent as-is:
 * the backend widens it back to every thread, per the spec.
 */
export function ThreadsPanel(props: { store: ProfileStore; summary: ProfileSummary }) {
  const [nameFilter, setNameFilter] = createSignal('');

  const allIds = () => props.summary.threads.map((t) => t.id);

  // `null` means "no thread filter": every thread selected.
  const selected = () => props.store.filters().threads ?? null;

  const isChecked = (id: number) => {
    const ids = selected();
    return ids === null || ids.includes(id);
  };

  const selectedCount = () => selected()?.length ?? props.summary.threads.length;

  const setThreads = (ids: number[] | null) => {
    props.store.setFilters({
      ...props.store.filters(),
      threads: ids === null || ids.length === allIds().length ? undefined : ids,
    });
  };

  const toggle = (id: number) => {
    const base = selected() ?? allIds();
    setThreads(base.includes(id) ? base.filter((t) => t !== id) : [...base, id]);
  };

  const invert = () => {
    const current = selected() ?? allIds();
    setThreads(allIds().filter((id) => !current.includes(id)));
  };

  const rows = createMemo(() => {
    const wanted = nameFilter().toLowerCase();
    return props.summary.threads
      .map((thread, i) => ({
        thread,
        count: props.summary.thread_sample_counts[i] ?? 0,
      }))
      .filter(({ thread }) => thread.name.toLowerCase().includes(wanted))
      .sort((a, b) => b.count - a.count || a.thread.name.localeCompare(b.thread.name));
  });

  const share = (count: number) =>
    props.summary.sample_count === 0
      ? '—'
      : `${Math.round((100 * count) / props.summary.sample_count)} %`;

  return (
    <aside class="threads-panel" aria-label="Threads">
      <header>
        <h3>
          Threads ({selectedCount()}/{props.summary.threads.length})
        </h3>
        <input
          type="search"
          placeholder="filter…"
          aria-label="Filter threads by name"
          value={nameFilter()}
          onInput={(e) => setNameFilter(e.currentTarget.value)}
        />
      </header>
      <ul>
        <For each={rows()}>
          {({ thread, count }) => (
            <li>
              <label class="thread-row">
                <input
                  type="checkbox"
                  checked={isChecked(thread.id)}
                  onChange={() => toggle(thread.id)}
                />
                <span class="thread-name">{thread.name}</span>
                <span class="thread-share">{share(count)}</span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <footer class="thread-actions">
        <button onClick={() => setThreads(null)}>All</button>
        <button onClick={() => setThreads([])}>None</button>
        <button onClick={invert}>Invert</button>
      </footer>
    </aside>
  );
}
