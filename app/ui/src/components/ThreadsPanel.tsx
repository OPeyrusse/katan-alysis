import { For, Show, createMemo, createSignal } from 'solid-js';
import type { ProfileSummary } from '../api/client';
import type { ProfileStore } from '../state/profile';

/**
 * Thread selection, ordered by whole-recording activity so entries do not
 * jump around while the analyst filters.
 *
 * No thread filter and every thread ticked narrow the same samples, so the
 * panel keeps a single representation for it: no filter, nothing ticked.
 * Picking a thread from there narrows to that thread alone instead of
 * excluding it — the analyst who clicks a name is asking to see it, and it
 * spares them the deselect-everything-first detour. Once a filter exists the
 * ticks mean what they usually do: add, remove, invert.
 */
export function ThreadsPanel(props: { store: ProfileStore; summary: ProfileSummary }) {
  const [nameFilter, setNameFilter] = createSignal('');

  const allIds = () => props.summary.threads.map((t) => t.id);

  // `null` means "no thread filter": every thread contributes.
  const selected = () => props.store.filters().threads ?? null;

  const isChecked = (id: number) => selected()?.includes(id) ?? false;

  // Neither an empty nor a complete selection is a filter, and both read as
  // "no filter" in this panel: they are normalised away as they are made, so
  // "every thread" has exactly one representation.
  const setThreads = (ids: number[] | null) => {
    props.store.setFilters({
      ...props.store.filters(),
      threads:
        ids === null || ids.length === 0 || ids.length === allIds().length ? undefined : ids,
    });
  };

  const toggle = (id: number) => {
    const base = selected();
    if (base === null) {
      setThreads([id]);
      return;
    }
    setThreads(base.includes(id) ? base.filter((t) => t !== id) : [...base, id]);
  };

  const invert = () => {
    const current = selected() ?? [];
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
          Threads (
          {selected() === null ? 'all' : `${selected()!.length}/${props.summary.threads.length}`})
        </h3>
        <input
          type="search"
          placeholder="filter…"
          aria-label="Filter threads by name"
          value={nameFilter()}
          onInput={(e) => setNameFilter(e.currentTarget.value)}
        />
      </header>
      <Show when={selected() === null}>
        <p class="thread-hint">No thread filter: every thread is included. Pick one to narrow.</p>
      </Show>
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
        <button
          disabled={selected() === null}
          title="Drop the thread filter: every thread is included"
          onClick={() => setThreads(null)}
        >
          Clear
        </button>
        <button onClick={invert}>Invert</button>
      </footer>
    </aside>
  );
}
