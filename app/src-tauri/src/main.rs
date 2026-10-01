#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let verbose = std::env::args().any(|arg| arg == "--verbose" || arg == "-v");
    katan_alysis_lib::run(verbose)
}
