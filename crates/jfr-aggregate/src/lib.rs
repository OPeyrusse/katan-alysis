//! Aggregations over a normalized [`Profile`].
//!
//! Every view is a pure function `(&Profile, &Filters) -> view model`.
//! Filters are applied to the sample stream before aggregation, so every
//! view benefits from them identically — there is no post-processing on
//! aggregated data.

use std::collections::HashMap;

use jfr_model::{Filters, Profile, StackId};

pub mod density;
pub mod overview;
pub mod thread_activity;
pub mod top_methods;

pub use density::sample_density;
pub use overview::resample_max;
pub use thread_activity::thread_sample_counts;
pub use top_methods::top_methods;

/// Counts the filtered samples per interned stack.
///
/// Views that don't need individual timestamps (top methods, flamegraph,
/// merged callers/callees) aggregate from these counts and thus walk each
/// unique stack once, not once per sample.
fn stack_counts(profile: &Profile, filters: &Filters) -> (HashMap<StackId, u64>, u64) {
    let mut counts: HashMap<StackId, u64> = HashMap::new();
    let mut total = 0u64;
    for sample in profile.samples.iter().filter(|s| filters.accepts(s)) {
        *counts.entry(sample.stack).or_default() += 1;
        total += 1;
    }
    (counts, total)
}
