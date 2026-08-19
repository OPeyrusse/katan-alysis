//! FlameScope-style heatmap: samples bucketed by column (a fixed span of
//! recording time) and row (position within that span), so a periodic
//! pattern lines up in the same rows across columns.
//!
//! Unlike [`super::density::sample_density`] — deliberately unfiltered,
//! since it draws the context strip under the brush — this view follows
//! the current selection like top-methods and the flamegraph: filters are
//! applied before aggregation, and the grid spans only the filtered
//! samples.

use jfr_model::{Filters, HeatmapGrid, Profile};

/// Width of one column: one second of recording time.
const COLUMN_NANOS: i64 = 1_000_000_000;
/// Width of one row within a column: 20ms, giving 50 rows per column.
const ROW_NANOS: i64 = 20_000_000;
const ROWS: usize = (COLUMN_NANOS / ROW_NANOS) as usize;

/// Buckets the filtered samples into the FlameScope grid.
pub fn heatmap(profile: &Profile, filters: &Filters) -> HeatmapGrid {
    let filtered: Vec<i64> = profile
        .samples
        .iter()
        .filter(|s| filters.accepts(s))
        .map(|s| s.ts_nanos)
        .collect();
    let (Some(&start), Some(&end)) = (filtered.first(), filtered.last()) else {
        return HeatmapGrid::default();
    };

    let span = end - start + 1;
    let column_count = ((span + COLUMN_NANOS - 1) / COLUMN_NANOS) as usize;
    let mut columns = vec![vec![0u64; ROWS]; column_count];
    let mut max_count = 0u64;
    for ts_nanos in filtered {
        let offset = ts_nanos - start;
        let column = (offset / COLUMN_NANOS) as usize;
        let row = ((offset % COLUMN_NANOS) / ROW_NANOS) as usize;
        let cell = &mut columns[column][row];
        *cell += 1;
        max_count = max_count.max(*cell);
    }

    HeatmapGrid {
        column_nanos: COLUMN_NANOS,
        row_nanos: ROW_NANOS,
        rows: ROWS,
        columns,
        max_count,
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
    fn columns_are_relative_to_the_first_filtered_sample() {
        let profile = profile_with_samples(&[1_000_000_000, 1_000_000_000 + COLUMN_NANOS]);
        let grid = heatmap(&profile, &Filters::default());
        assert_eq!(grid.columns.len(), 2);
        assert_eq!(grid.columns[0][0], 1);
        assert_eq!(grid.columns[1][0], 1);
    }

    #[test]
    fn thread_filter_restricts_the_grid() {
        let mut profile = profile_with_samples(&[0, 0]);
        profile.samples[1].thread = ThreadId(1);
        let filters = Filters {
            threads: Some(vec![ThreadId(1)]),
            ..Filters::default()
        };
        let grid = heatmap(&profile, &filters);
        let total: u64 = grid.columns.iter().flatten().sum();
        assert_eq!(total, 1);
    }

    #[test]
    fn time_filter_restricts_the_grid() {
        let profile = profile_with_samples(&[0, 10, COLUMN_NANOS]);
        let filters = Filters {
            time_range_nanos: Some((0, COLUMN_NANOS)),
            ..Filters::default()
        };
        let grid = heatmap(&profile, &filters);
        assert_eq!(grid.columns.len(), 1);
        let total: u64 = grid.columns.iter().flatten().sum();
        assert_eq!(total, 2);
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
