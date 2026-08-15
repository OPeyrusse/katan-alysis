// Typed wrappers over the Tauri IPC. Field names mirror the Rust structs
// (snake_case) exactly; timestamps are nanoseconds relative to the start of
// the recording (absolute epoch nanos would overflow JS safe integers).
import { invoke } from '@tauri-apps/api/core';

export interface Frame {
  class_name: string;
  method_name: string;
}

export interface ThreadInfo {
  id: number;
  name: string;
}

export interface ProfileSummary {
  sample_count: number;
  duration_nanos: number;
  threads: ThreadInfo[];
  frames: Frame[];
}

export interface MethodStats {
  self_samples: number;
  total_samples: number;
}

export interface TopMethods {
  rows: [number, MethodStats][];
  total_samples: number;
}

// An empty selection is not a filter: an empty thread list, or a range
// holding no instant, widens back to the whole recording. The UI can send
// the selection as-is — it never has to special-case "nothing selected".
export interface RelativeFilters {
  threads?: number[] | null;
  time_range_nanos?: [number, number] | null;
}

export function openRecording(path: string): Promise<ProfileSummary> {
  return invoke('open_recording', { path });
}

export function getTopMethods(filters: RelativeFilters): Promise<TopMethods> {
  return invoke('get_top_methods', { filters });
}

export function frameLabel(frames: Frame[], id: number): string {
  const frame = frames[id];
  return frame ? `${frame.class_name}.${frame.method_name}` : `#${id}`;
}
