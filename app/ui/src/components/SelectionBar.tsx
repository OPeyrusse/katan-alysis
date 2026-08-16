import { For, Show, createSignal } from 'solid-js';
import type { ProfileStore } from '../state/profile';
import { selectionLabel } from '../format';

/**
 * The top strip of every specialized view: what the current selection is,
 * the saved selections of this recording, and the actions on them. Saved
 * entries are applied through the dropdown; editing any filter afterwards
 * detaches the current selection without touching the entry.
 */
export function SelectionBar(props: { store: ProfileStore }) {
  const [renaming, setRenaming] = createSignal(false);
  let renameInput!: HTMLInputElement;

  const label = () =>
    selectionLabel(
      props.store.filters().time_range_nanos ?? null,
      props.store.filters().threads?.length ?? null,
    );

  const hasSelection = () => {
    const f = props.store.filters();
    return f.threads !== undefined || f.time_range_nanos !== undefined;
  };

  const applied = () => props.store.appliedSelection();

  const commitRename = () => {
    const name = applied();
    if (name) props.store.renameSelection(name, renameInput.value);
    setRenaming(false);
  };

  return (
    <div class="selection-bar">
      <label>
        Selection:{' '}
        <select
          aria-label="Saved selections"
          value={applied() ?? ''}
          onChange={(e) => {
            const name = e.currentTarget.value;
            if (name === '') props.store.clearSelection();
            else props.store.applySelection(name);
          }}
        >
          <option value="">— no selection —</option>
          <For each={props.store.selections()}>
            {(saved) => <option value={saved.name}>{saved.name}</option>}
          </For>
        </select>
      </label>

      <span class="selection-summary">
        <strong>{label()}</strong>
        <Show when={hasSelection() && !applied()}> (unsaved)</Show>
      </span>

      <span class="selection-actions">
        <button
          disabled={!hasSelection() || applied() !== undefined}
          title="Save the current selection under a name"
          onClick={() => props.store.saveSelection()}
        >
          Save
        </button>
        <Show when={applied()}>
          {(name) => (
            <>
              <Show
                when={renaming()}
                fallback={
                  <button aria-label="Rename selection" onClick={() => setRenaming(true)}>
                    ✎
                  </button>
                }
              >
                <input
                  ref={renameInput}
                  aria-label="New selection name"
                  value={name()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  onBlur={commitRename}
                />
              </Show>
              <button
                aria-label="Delete selection"
                onClick={() => props.store.deleteSelection(name())}
              >
                ✕
              </button>
            </>
          )}
        </Show>
      </span>
    </div>
  );
}
