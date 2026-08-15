import { Show, createSignal } from 'solid-js';
import type { ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import { maxValue, niceCeiling } from '../../render/charts';
import { formatClock } from '../../format';
import { InfoBanner } from './InfoBanner';
import { SignalChart, type ChartInteraction } from './SignalChart';

/**
 * The JMC-style overview: key facts extracted from the recording, then
 * four charts sharing the recording's time axis — CPU, heap, process
 * memory (RSS) and GC pauses. Brushing any chart narrows the time filter
 * and jumps to the top-methods view ("analyze this period"); the hover
 * cursor is synchronised across the four charts.
 */
export function OverviewView(props: { store: ProfileStore; summary: ProfileSummary }) {
  const [cursor, setCursor] = createSignal<number>();

  const duration = () => props.summary.duration_nanos;

  const interaction = (): ChartInteraction => ({
    cursor: cursor(),
    onCursor: setCursor,
    onBrush: (range) => {
      props.store.setFilters({ time_range_nanos: range });
      props.store.setActiveView('top-methods');
    },
  });

  return (
    <section class="view-overview" aria-label="Overview view">
      <Show when={props.store.info()}>
        {(info) => <InfoBanner info={info()} />}
      </Show>

      <Show when={props.store.overviewSignals()}>
        {(signals) => {
          const heapCeiling = () =>
            niceCeiling(
              Math.max(
                maxValue([signals().heap_used_bytes, signals().heap_committed_bytes]),
                props.store.info()?.heap_max_bytes ?? 0,
              ),
            );
          const gcCeiling = () =>
            niceCeiling(Math.max(...signals().gc_pauses.map((p) => p.duration_nanos), 0));
          return (
            <div class="overview-charts">
              <SignalChart
                title="CPU"
                unitLabel="%"
                ceiling={1}
                series={[
                  { label: 'jvm user', points: signals().cpu_jvm_user, color: '#4a7dbd' },
                  { label: 'jvm system', points: signals().cpu_jvm_system, color: '#bd4a6f' },
                  {
                    label: 'machine total',
                    points: signals().cpu_machine_total,
                    color: '#8a8a8a',
                    dashed: true,
                  },
                ]}
                durationNanos={duration()}
                interaction={interaction()}
              />
              <SignalChart
                title="Heap"
                unitLabel="bytes"
                ceiling={heapCeiling()}
                series={[
                  { label: 'used', points: signals().heap_used_bytes, color: '#4a9d6e' },
                  {
                    label: 'committed',
                    points: signals().heap_committed_bytes,
                    color: '#4a9d6e',
                    dashed: true,
                  },
                ]}
                durationNanos={duration()}
                interaction={interaction()}
              />
              <SignalChart
                title="Process memory"
                unitLabel="bytes"
                ceiling={niceCeiling(maxValue([signals().rss_bytes]))}
                series={[
                  {
                    label: 'RSS: heap + off-heap + native',
                    points: signals().rss_bytes,
                    color: '#7a5abd',
                  },
                ]}
                durationNanos={duration()}
                interaction={interaction()}
              />
              <SignalChart
                title="GC pauses"
                unitLabel="ms"
                ceiling={gcCeiling()}
                pauses={signals().gc_pauses}
                durationNanos={duration()}
                interaction={interaction()}
              />
              <footer class="overview-axis">
                <span>0:00</span>
                <Show when={cursor() !== undefined}>
                  <span class="cursor-time">
                    {formatClock((cursor() ?? 0) * duration())}
                  </span>
                </Show>
                <span>{formatClock(duration())}</span>
              </footer>
              <p class="muted overview-hint">
                Drag on any chart to analyze that period in the top-methods view.
              </p>
            </div>
          );
        }}
      </Show>
    </section>
  );
}
