import { For } from 'solid-js';
import { frameLabel, type Frame, type TopMethods } from '../api/client';

/**
 * Flat profile table; rows arrive already sorted by the backend. Each
 * method name opens the merged-calls view focused on it, when a handler
 * is given.
 */
export function TopMethodsTable(props: {
  frames: Frame[];
  view: TopMethods;
  onSelectFrame?: (frameId: number) => void;
}) {
  const percent = (samples: number) =>
    props.view.total_samples === 0
      ? '—'
      : `${((100 * samples) / props.view.total_samples).toFixed(1)}%`;

  return (
    <table aria-label="Top methods">
      <thead>
        <tr>
          <th>Method</th>
          <th>Self</th>
          <th>Self %</th>
          <th>Total</th>
          <th>Total %</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.view.rows}>
          {([frameId, stats]) => (
            <tr>
              <td>
                {props.onSelectFrame ? (
                  <button
                    type="button"
                    class="link-button"
                    onClick={() => props.onSelectFrame?.(frameId)}
                  >
                    {frameLabel(props.frames, frameId)}
                  </button>
                ) : (
                  frameLabel(props.frames, frameId)
                )}
              </td>
              <td>{stats.self_samples}</td>
              <td>{percent(stats.self_samples)}</td>
              <td>{stats.total_samples}</td>
              <td>{percent(stats.total_samples)}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
