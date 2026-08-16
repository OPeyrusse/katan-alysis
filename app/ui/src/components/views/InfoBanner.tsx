import { Show } from 'solid-js';
import type { RecordingInfo, UnsignedFlag } from '../../api/client';
import { formatBytes } from '../../format';

const NA = 'n/a';

/** First line of the (possibly multi-line) OS description. */
function osSummary(info: RecordingInfo): string {
  const os = info.os_version;
  if (!os) return NA;
  const uname = os
    .split('\n')
    .find((line) => line.startsWith('uname:'))
    ?.replace('uname:', '')
    .trim();
  return uname ?? os.split('\n')[0];
}

function flagValue(flag: UnsignedFlag | null): string {
  if (!flag) return NA;
  const origin = flag.origin === 'Command line' ? '' : ` (${flag.origin.toLowerCase()})`;
  return `${formatBytes(flag.value)}${origin}`;
}

/**
 * The key facts extracted from the recording: JVM, GC and system columns
 * plus the Options strip (Xmx/Xms, MaxDirectMemorySize,
 * DebugNonSafepoints). Absent facts show as n/a — a recording without
 * metadata is normal, not an error.
 */
export function InfoBanner(props: { info: RecordingInfo }) {
  const gcName = () => {
    const young = props.info.young_collector;
    const old = props.info.old_collector;
    if (!young && !old) return NA;
    return young && old ? `${young} / ${old}` : (young ?? old ?? NA);
  };

  const cpu = () => {
    if (props.info.cpu_cores === null) return NA;
    const threads =
      props.info.hw_threads !== null ? ` · ${props.info.hw_threads} hw threads` : '';
    return `${props.info.cpu_cores} cores${threads}`;
  };

  const dns = () => {
    const flag = props.info.debug_non_safepoints;
    if (!flag) return NA;
    return flag.value ? '✓ enabled' : '✗ disabled';
  };

  return (
    <div class="info-banner">
      <div class="info-columns">
        <section aria-label="JVM">
          <h3>JVM</h3>
          <p>{props.info.jvm_name ?? NA}</p>
          <p class="muted">{props.info.jvm_version?.split(' for ')[0] ?? ''}</p>
        </section>
        <section aria-label="GC">
          <h3>GC</h3>
          <p>{gcName()}</p>
          <p class="muted">
            Heap max{' '}
            {props.info.heap_max_bytes !== null
              ? formatBytes(props.info.heap_max_bytes)
              : NA}
          </p>
        </section>
        <section aria-label="System">
          <h3>System</h3>
          <p>{osSummary(props.info)}</p>
          <p class="muted">
            {cpu()}
            <Show when={props.info.physical_memory_bytes !== null}>
              {' '}
              · {formatBytes(props.info.physical_memory_bytes ?? 0)} RAM
            </Show>
          </p>
        </section>
      </div>
      <div class="info-options" aria-label="Options">
        <strong>Options</strong> Xmx {flagValue(props.info.xmx)} · Xms{' '}
        {flagValue(props.info.xms)} · MaxDirectMemorySize{' '}
        {flagValue(props.info.max_direct_memory)} · DebugNonSafepoints {dns()}
      </div>
    </div>
  );
}
