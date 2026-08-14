import { Show } from 'solid-js';
import { createProfileStore, type ProfileStore } from './state/profile';
import { TopMethodsTable } from './components/TopMethodsTable';

export function App(props: { store?: ProfileStore }) {
  // Test-injection seam, read once on purpose: the store lives as long as
  // the component and is never swapped.
  // eslint-disable-next-line solid/reactivity
  const store = props.store ?? createProfileStore();
  let pathInput!: HTMLInputElement;

  return (
    <main>
      <h1>katan-alysis</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void store.open(pathInput.value);
        }}
      >
        <label>
          JFR file path: <input ref={pathInput} type="text" name="path" />
        </label>
        <button type="submit">Open</button>
      </form>
      <Show when={store.error()}>
        <p role="alert">{store.error()}</p>
      </Show>
      <Show
        when={store.summary()}
        fallback={<p>Open a JFR recording to get started.</p>}
      >
        {(summary) => (
          <>
            <p>
              {summary().sample_count} samples,{' '}
              {(summary().duration_nanos / 1_000_000_000).toFixed(1)} s,{' '}
              {summary().threads.length} threads
            </p>
            <Show when={store.topMethods()}>
              {(view) => <TopMethodsTable frames={summary().frames} view={view()} />}
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}
