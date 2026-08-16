//! Downsampling of the overview signals for the IPC boundary.
//!
//! The charts draw a few hundred pixels; shipping every recorded point
//! would only bloat the payload. Buckets keep their maximum so spikes —
//! the points the analyst is looking for — survive the downsampling.

use jfr_model::TimePoint;

/// At most `max_points` points spanning the same range, one per uniform
/// time bucket, each bucket represented by its maximum value.
pub fn resample_max(points: &[TimePoint], max_points: usize) -> Vec<TimePoint> {
    if max_points == 0 || points.len() <= max_points {
        return points.to_vec();
    }
    let start = points
        .first()
        .expect("non-empty by the guard above")
        .ts_nanos;
    let end = points.last().expect("sorted input").ts_nanos;
    let span = end - start + 1;
    let bucket_nanos = (span + max_points as i64 - 1) / max_points as i64;

    let mut resampled: Vec<TimePoint> = Vec::with_capacity(max_points);
    let mut current_bucket = -1i64;
    for point in points {
        let bucket = (point.ts_nanos - start) / bucket_nanos;
        if bucket != current_bucket {
            resampled.push(*point);
            current_bucket = bucket;
        } else if let Some(last) = resampled.last_mut()
            && point.value > last.value
        {
            *last = *point;
        }
    }
    resampled
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(values: &[(i64, f64)]) -> Vec<TimePoint> {
        values
            .iter()
            .map(|&(ts_nanos, value)| TimePoint { ts_nanos, value })
            .collect()
    }

    #[test]
    fn short_series_pass_through_unchanged() {
        let series = points(&[(0, 1.0), (10, 2.0)]);
        assert_eq!(resample_max(&series, 10), series);
        assert_eq!(resample_max(&[], 10), vec![]);
    }

    #[test]
    fn buckets_keep_their_maximum() {
        // Two buckets of 50 ns; the spike at t=30 must survive.
        let series = points(&[(0, 1.0), (30, 9.0), (40, 2.0), (60, 3.0), (99, 1.0)]);
        let resampled = resample_max(&series, 2);
        assert_eq!(resampled.len(), 2);
        assert_eq!(resampled[0].value, 9.0);
        assert_eq!(resampled[1].value, 3.0);
    }

    #[test]
    fn never_returns_more_than_max_points() {
        let series: Vec<TimePoint> = (0..1000)
            .map(|i| TimePoint {
                ts_nanos: i,
                value: i as f64,
            })
            .collect();
        let resampled = resample_max(&series, 100);
        assert!(resampled.len() <= 100);
        // Monotonic input: every kept point is its bucket's last value.
        assert_eq!(resampled.last().unwrap().value, 999.0);
    }

    #[test]
    fn zero_max_points_passes_through() {
        let series = points(&[(0, 1.0)]);
        assert_eq!(resample_max(&series, 0), series);
    }
}
