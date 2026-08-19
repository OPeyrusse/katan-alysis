import { Show } from 'solid-js';
import type { ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import { TopMethodsTable } from '../TopMethodsTable';

/** The flat-profile view: sample count of the selection plus the table. */
export function TopMethodsView(props: { store: ProfileStore; summary: ProfileSummary }) {
  return (
    <section class="view-top-methods" aria-label="Top methods view">
      <Show when={props.store.topMethods()}>
        {(view) => (
          <>
            <p class="selection-size">
              {view().total_samples.toLocaleString('en-US')} samples in selection
            </p>
            <TopMethodsTable
              frames={props.summary.frames}
              view={view()}
              onSelectFrame={props.store.selectFrame}
            />
          </>
        )}
      </Show>
    </section>
  );
}
