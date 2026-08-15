import { Match, Show, Switch, onCleanup, onMount } from 'solid-js';
import { createProfileStore, type ProfileStore } from './state/profile';
import { tauriShell, type Shell } from './api/shell';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Sidebar } from './components/Sidebar';
import { SelectionChrome } from './components/SelectionChrome';
import { TopMethodsView } from './components/views/TopMethodsView';
import { OverviewView } from './components/views/OverviewView';
import { basename } from './format';

export function App(props: { store?: ProfileStore; shell?: Shell }) {
  // Test-injection seams, read once on purpose: both live as long as the
  // component and are never swapped.
  // eslint-disable-next-line solid/reactivity
  const store = props.store ?? createProfileStore();
  // eslint-disable-next-line solid/reactivity
  const shell = props.shell ?? tauriShell;

  onMount(() => {
    // Dropping a .jfr anywhere on the window opens it, welcome screen or
    // not: dropping over a loaded recording switches to the new one.
    const listening = shell.onFileDrop((path) => void store.open(path));
    onCleanup(() => void listening.then((unlisten) => unlisten()));
  });

  return (
    <Show
      when={store.summary()}
      fallback={<WelcomeScreen store={store} shell={shell} />}
    >
      {(summary) => (
        <div class="workspace">
          <header class="titlebar">
            <span class="recording-name">
              {basename(store.openedPath() ?? 'recording')}
            </span>
            <button onClick={() => void store.close()}>Close</button>
          </header>
          <Show when={store.error()}>
            <p role="alert">{store.error()}</p>
          </Show>
          <div class="workspace-body">
            <Sidebar store={store} summary={summary()} />
            <main class="view-host">
              <Switch>
                <Match when={store.activeView() === 'overview'}>
                  <OverviewView />
                </Match>
                <Match when={store.activeView() === 'top-methods'}>
                  <SelectionChrome store={store} summary={summary()}>
                    <TopMethodsView store={store} summary={summary()} />
                  </SelectionChrome>
                </Match>
              </Switch>
            </main>
          </div>
        </div>
      )}
    </Show>
  );
}
