//! FlameScope-style heatmap: samples bucketed by column (a fixed span of
//! recording time) and row (position within that span), so a periodic
//! pattern lines up in the same rows across columns.
//!
//! Columns always span the whole recording, like
//! [`super::density::sample_density`] and for the same reason — this is
//! the surface the analyst brushes a time window on, so it needs the whole
//! recording as context. Filters still apply, unlike the density strip:
//! they narrow which samples populate a cell, never the grid's shape, so a
//! selection stays visible against the rest of the recording instead of
//! disappearing into a regenerated grid.

use jfr_model::{Filters, HeatmapGrid, Profile};

/// Width of one column: one second of recording time.
const COLUMN_NANOS: i64 = 1_000_000_000;
/// Width of one row within a column: 20ms, giving 50 rows per column.
const ROW_NANOS: i64 = 20_000_000;
const ROWS: usize = (COLUMN_NANOS / ROW_NANOS) as usize;

/// Buckets the filtered samples into the FlameScope grid.
pub fn heatmap(profile: &Profile, filters: &Filters) -> HeatmapGrid {
    let Some((start, end)) = profile.time_range_nanos() else {
        return HeatmapGrid::default();
    };

    // Half-open columns over an inclusive sample range: stretch the span by
    // one nanosecond so the last sample lands inside the last column.
    let span = end - start + 1;
    let column_count = ((span + COLUMN_NANOS - 1) / COLUMN_NANOS) as usize;
    let mut columns = vec![vec![0u64; ROWS]; column_count];
    let mut context_columns = vec![vec![0u64; ROWS]; column_count];
    let mut max_count = 0u64;
    let mut context_max_count = 0u64;
    let context_filters = Filters {
        threads: filters.threads.clone(),
        time_range_nanos: None,
    };
    for sample in &profile.samples {
        let offset = sample.ts_nanos - start;
        let column = (offset / COLUMN_NANOS) as usize;
        let row = ((offset % COLUMN_NANOS) / ROW_NANOS) as usize;
        if context_filters.accepts(sample) {
            let cell = &mut context_columns[column][row];
            *cell += 1;
            context_max_count = context_max_count.max(*cell);
        }
        if filters.accepts(sample) {
            let cell = &mut columns[column][row];
            *cell += 1;
            max_count = max_count.max(*cell);
        }
    }

    HeatmapGrid {
        column_nanos: COLUMN_NANOS,
        row_nanos: ROW_NANOS,
        rows: ROWS,
        columns,
        max_count,
        context_columns,
        context_max_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jfr_model::{Sample, StackId, ThreadId};

    fn profile_with_samples(ts: &[i64]) -> Profile {
        Profile {
            samples: ts
                .iter()
                .map(|&ts_nanos| Sample {
                    ts_nanos,
                    thread: ThreadId(0),
                    stack: StackId(0),
                })
                .collect(),
            ..Profile::default()
        }
    }

    #[test]
    fn an_empty_profile_has_an_empty_grid() {
        assert_eq!(
            heatmap(&Profile::default(), &Filters::default()),
            HeatmapGrid::default()
        );
    }

    #[test]
    fn every_sample_lands_in_exactly_one_cell() {
        let profile = profile_with_samples(&[0, 20_000_000, 999_999_999, 1_000_000_000]);
        let grid = heatmap(&profile, &Filters::default());

        assert_eq!(grid.column_nanos, COLUMN_NANOS);
        assert_eq!(grid.row_nanos, ROW_NANOS);
        assert_eq!(grid.rows, 50);
        assert_eq!(grid.columns.len(), 2);
        let total: u64 = grid.columns.iter().flatten().sum();
        assert_eq!(total, profile.samples.len() as u64);
    }

    #[test]
    fn a_sample_lands_in_the_row_matching_its_offset_within_the_column() {
        // Relative to the first sample (t=0): itself in row 0, the second
        // one 25ms later in row 1 (20-40ms), both in column 0.
        let profile = profile_with_samples(&[0, 25_000_000]);
        let grid = heatmap(&profile, &Filters::default());

        assert_eq!(grid.columns.len(), 1);
        assert_eq!(grid.columns[0][0], 1);
        assert_eq!(grid.columns[0][1], 1);
        assert_eq!(grid.max_count, 1);
    }

    #[test]
    fn max_count_is_the_tallest_cell() {
        // Three samples share row 0, one lands alone in row 1.
        let profile = profile_with_samples(&[0, 0, 0, ROW_NANOS]);
        let grid = heatmap(&profile, &Filters::default());
        assert_eq!(grid.max_count, 3);
    }

    #[test]
    fn columns_span_the_whole_recording_regardless_of_the_time_filter() {
        let profile = profile_with_samples(&[0, COLUMN_NANOS, 2 * COLUMN_NANOS]);
        let filters = Filters {
            time_range_nanos: Some((0, COLUMN_NANOS)),
            ..Filters::default()
        };
        let grid = heatmap(&profile, &filters);

        // The grid keeps its full three-column shape...
        assert_eq!(grid.columns.len(), 3);
        // ...only the first column holds a sample.
        assert_eq!(grid.columns[0][0], 1);
        assert_eq!(grid.columns[1][0], 0);
        assert_eq!(grid.columns[2][0], 0);
    }

    #[test]
    fn thread_filter_narrows_the_counts_not_the_grid() {
        let mut profile = profile_with_samples(&[0, 0]);
        profile.samples[1].thread = ThreadId(1);
        let filters = Filters {
            threads: Some(vec![ThreadId(1)]),
            ..Filters::default()
        };
        let grid = heatmap(&profile, &filters);
        assert_eq!(grid.columns.len(), 1);
        assert_eq!(grid.columns[0][0], 1);
    }

    #[test]
    fn context_columns_ignore_the_time_filter_but_keep_the_thread_filter() {
        let mut profile = profile_with_samples(&[0, COLUMN_NANOS, 2 * COLUMN_NANOS]);
        profile.samples[1].thread = ThreadId(1);
        let filters = Filters {
            threads: Some(vec![ThreadId(0)]),
            time_range_nanos: Some((0, COLUMN_NANOS)),
        };
        let grid = heatmap(&profile, &filters);

        // The selection grid only sees column 0, thread 0.
        assert_eq!(grid.columns[0][0], 1);
        assert_eq!(grid.columns[1][0], 0);
        assert_eq!(grid.columns[2][0], 0);
        assert_eq!(grid.max_count, 1);

        // The context grid spans every column but still excludes thread 1.
        assert_eq!(grid.context_columns[0][0], 1);
        assert_eq!(grid.context_columns[1][0], 0);
        assert_eq!(grid.context_columns[2][0], 1);
        assert_eq!(grid.context_max_count, 1);
    }

    #[test]
    fn an_empty_filter_widens_instead_of_emptying_the_grid() {
        let profile = profile_with_samples(&[0, 500_000_000, 1_500_000_000]);
        let unfiltered = heatmap(&profile, &Filters::default());

        for filters in [
            Filters {
                threads: Some(vec![]),
                ..Filters::default()
            },
            Filters {
                time_range_nanos: Some((5, 5)),
                ..Filters::default()
            },
        ] {
            let grid = heatmap(&profile, &filters);
            assert_eq!(grid, unfiltered, "filters {filters:?}");
        }
    }
}
