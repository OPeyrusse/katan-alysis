// Shared test fixtures for the overview data: a recording with no
// metadata and no signals — the minimal-recording shape.
import type { OverviewSignals, RecordingInfo } from '../api/client';

export function emptySignals(): OverviewSignals {
  return {
    cpu_jvm_user: [],
    cpu_jvm_system: [],
    cpu_machine_total: [],
    heap_used_bytes: [],
    heap_committed_bytes: [],
    rss_bytes: [],
    gc_pauses: [],
  };
}

export function nullInfo(): RecordingInfo {
  return {
    jvm_name: null,
    jvm_version: null,
    young_collector: null,
    old_collector: null,
    heap_max_bytes: null,
    os_version: null,
    cpu_cores: null,
    hw_threads: null,
    physical_memory_bytes: null,
    xmx: null,
    xms: null,
    max_direct_memory: null,
    debug_non_safepoints: null,
  };
}
