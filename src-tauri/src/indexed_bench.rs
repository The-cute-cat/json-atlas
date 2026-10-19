//! Opt-in, reproducible release benchmark. Timings exclude fixture generation.
use super::*;
use std::io::BufWriter;
use std::time::{Instant, UNIX_EPOCH};

thread_local! { static SCALAR_BASELINE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
pub(super) fn scalar_baseline() -> bool {
    SCALAR_BASELINE.with(|flag| flag.get())
}
fn with_scalar<T>(scalar: bool, run: impl FnOnce() -> T) -> T {
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            SCALAR_BASELINE.with(|flag| flag.set(self.0));
        }
    }
    let _reset = Reset(SCALAR_BASELINE.with(|flag| flag.replace(scalar)));
    run()
}

#[test]
#[ignore = "release benchmark: ASCII, UTF-8 and escape-heavy string scanning"]
fn string_scan_benchmark() {
    for (name, value) in [
        ("ascii", "a".repeat(8192)),
        ("utf8", "中文😀".repeat(819)),
        ("escapes", "ab\\\n\"中".repeat(1024)),
    ] {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("atlas-strings-{}-{stamp}", std::process::id()));
        let path = base.with_extension("json");
        let index = base.with_extension("idx");
        let encoded = serde_json::to_string(&value).unwrap();
        {
            let mut writer = BufWriter::new(File::create(&path).unwrap());
            write!(writer, "[").unwrap();
            for i in 0..4096 {
                if i > 0 {
                    write!(writer, ",").unwrap();
                }
                writer.write_all(encoded.as_bytes()).unwrap();
            }
            write!(writer, "]").unwrap();
            writer.flush().unwrap();
        }
        for run in 1..=3 {
            // Alternate order within the same process rather than comparing
            // measurements from separate runs under different system load.
            for scalar in if run % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let start = Instant::now();
                let mut doc = with_scalar(scalar, || {
                    Indexed::open(
                        path.to_str().unwrap(),
                        index.clone(),
                        &AtomicBool::new(false),
                        &|_| {},
                    )
                })
                .unwrap();
                let open = start.elapsed();
                assert_eq!(doc.text(&[json!(4095)], true).unwrap(), value);
                eprintln!(
                "STRING_BENCH kind={name} scalar={scalar} run={run} source_bytes={} open_ms={:.3}",
                path.metadata().unwrap().len(),
                open.as_secs_f64() * 1000.
            );
                drop(doc);
            }
        }
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
#[ignore = "release I/O benchmark: 200,000 JSONL rows with six fields"]
fn jsonl_many_fields_benchmark() {
    benchmark(200_000, 3);
}

#[test]
#[ignore = "release I/O benchmark: about 256 MiB JSONL with six fields per row"]
fn jsonl_256mib_benchmark() {
    benchmark(3_500_000, 1);
}

#[test]
#[ignore = "release native search benchmark: JSON and JSONL, 200,000 six-field records"]
fn native_search_benchmark() {
    for ext in ["json", "jsonl"] {
        let base = std::env::temp_dir().join(format!(
            "atlas-native-search-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = base.with_extension(ext);
        let index = base.with_extension("idx");
        {
            let mut out = BufWriter::new(File::create(&path).unwrap());
            if ext == "json" {
                write!(out, "[").unwrap();
            }
            for id in 0..200_000 {
                if ext == "json" && id > 0 {
                    write!(out, ",").unwrap();
                }
                write!(out,r#"{{"id":{id},"name":"item","active":true,"score":1,"group":"a","value":null}}"#).unwrap();
                if ext == "jsonl" {
                    writeln!(out).unwrap();
                }
            }
            if ext == "json" {
                write!(out, "]").unwrap();
            }
            out.flush().unwrap();
        }
        let doc = Arc::new(Mutex::new(
            Indexed::open(
                path.to_str().unwrap(),
                index,
                &AtomicBool::new(false),
                &|_| {},
            )
            .unwrap(),
        ));
        for query in ["no-such-value", "199999", "^id 199999$"] {
            let options = serde_json::from_value(json!({"searchId":"bench","query":query,
                "nativePattern": if query.starts_with('^') {Some(query)}else{None}}))
            .unwrap();
            let start = Instant::now();
            let result = doc
                .lock()
                .unwrap()
                .search_copy()
                .unwrap()
                .native_search(&options, &AtomicBool::new(false))
                .unwrap();
            assert_eq!(
                result["hits"].as_array().unwrap().len(),
                if query == "199999" {
                    2
                } else if query.starts_with('^') {
                    1
                } else {
                    0
                }
            );
            eprintln!(
                "NATIVE_SEARCH kind={ext} source_bytes={} query={query} elapsed_ms={:.3}",
                path.metadata().unwrap().len(),
                start.elapsed().as_secs_f64() * 1000.
            );
        }
        let mut snapshot = doc.lock().unwrap().search_copy().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let options =
            serde_json::from_value(json!({"searchId":"cancel","query":"missing"})).unwrap();
        let worker = std::thread::spawn(move || snapshot.native_search(&options, &worker_cancel));
        std::thread::sleep(std::time::Duration::from_millis(10));
        let start = Instant::now();
        assert_eq!(
            doc.lock()
                .unwrap()
                .page(&[], 199900, None, 100, false, true)
                .unwrap()["total"],
            200_000
        );
        let page = start.elapsed();
        let start = Instant::now();
        cancel.store(true, Ordering::Relaxed);
        assert!(worker.join().unwrap().unwrap_err().contains("取消"));
        eprintln!(
            "NATIVE_SEARCH kind={ext} concurrent_page_ms={:.3} cancel_join_ms={:.3}",
            page.as_secs_f64() * 1000.,
            start.elapsed().as_secs_f64() * 1000.
        );
        drop(doc);
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
#[ignore = "release I/O benchmark: ordinary JSON array with 200,000 six-field objects"]
fn json_many_fields_benchmark() {
    json_benchmark(200_000, 3);
}

#[test]
#[ignore = "release I/O benchmark: about 256 MiB ordinary JSON with six fields per item"]
fn json_256mib_benchmark() {
    json_benchmark(3_500_000, 1);
}

#[test]
#[ignore = "release benchmark: locate the last key and a missing key in a 200,000-field object"]
fn wide_object_lookup_benchmark() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!("atlas-wide-{}-{stamp}", std::process::id()));
    let path = base.with_extension("json");
    let index = base.with_extension("idx");
    {
        let mut file = BufWriter::new(File::create(&path).unwrap());
        write!(file, "{{").unwrap();
        for i in 0..200_000 {
            if i > 0 {
                write!(file, ",").unwrap();
            }
            write!(file, r#""field_{i:06}":{{"v":{{"value":{i}}}}}"#).unwrap();
        }
        write!(file, "}}").unwrap();
        file.flush().unwrap();
    }
    for run in 1..=3 {
        let start = Instant::now();
        let mut doc = Indexed::open(
            path.to_str().unwrap(),
            index.clone(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        let open = start.elapsed();
        let start = Instant::now();
        assert_eq!(
            doc.text(&[json!("field_199999"), json!("v"), json!("value")], true)
                .unwrap(),
            "199999"
        );
        let resolve = start.elapsed();
        let start = Instant::now();
        assert_eq!(
            doc.page(&[], 0, Some(&json!("field_199999")), 100, false, true)
                .unwrap()["start"],
            199900
        );
        let page_key = start.elapsed();
        let start = Instant::now();
        assert!(doc
            .text(&[json!("missing")], true)
            .unwrap_err()
            .contains("节点不存在"));
        let missing = start.elapsed();
        let index_bytes = index.metadata().unwrap().len()
            + doc
                .children
                .as_ref()
                .map(|f| f.metadata().unwrap().len())
                .unwrap_or(0)
            + doc
                .branches
                .as_ref()
                .map(|f| f.metadata().unwrap().len())
                .unwrap_or(0)
            + doc
                .keys
                .as_ref()
                .map(|f| f.metadata().unwrap().len())
                .unwrap_or(0);
        eprintln!("WIDE_BENCH run={run} source_bytes={} index_bytes={index_bytes} open_ms={:.3} resolve_last_ms={:.3} page_key_ms={:.3} missing_ms={:.3}",path.metadata().unwrap().len(),open.as_secs_f64()*1000.,resolve.as_secs_f64()*1000.,page_key.as_secs_f64()*1000.,missing.as_secs_f64()*1000.);
        drop(doc);
    }
    std::fs::remove_file(path).unwrap();
}

fn json_benchmark(rows: u64, runs: usize) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "atlas-json-benchmark-{}-{stamp}",
        std::process::id()
    ));
    let path = base.with_extension("json");
    let index = base.with_extension("idx");
    {
        let mut file = BufWriter::new(File::create(&path).unwrap());
        write!(file, "[").unwrap();
        for id in 0..rows {
            if id > 0 {
                write!(file, ",").unwrap();
            }
            write!(
                file,
                r#"{{"id":{id},"name":"item","active":true,"score":1,"group":"a","value":null}}"#
            )
            .unwrap();
        }
        write!(file, "]").unwrap();
        file.flush().unwrap();
    }
    for run in 1..=runs {
        let modes = if rows <= 200_000 {
            if run % 2 == 0 {
                vec![false, true]
            } else {
                vec![true, false]
            }
        } else {
            vec![false]
        };
        for scalar in modes {
            let start = Instant::now();
            let mut doc = with_scalar(scalar, || {
                Indexed::open(
                    path.to_str().unwrap(),
                    index.clone(),
                    &AtomicBool::new(false),
                    &|_| {},
                )
            })
            .unwrap();
            let open = start.elapsed();
            let start = Instant::now();
            assert_eq!(
                doc.page(&[], 0, None, 100, false, true).unwrap()["items"][0]["key"],
                0
            );
            let first = start.elapsed();
            let start = Instant::now();
            assert_eq!(
                doc.page(&[], rows - 100, None, 100, false, true).unwrap()["items"][99]["key"],
                rows - 1
            );
            let last = start.elapsed();
            assert_eq!(
                doc.text(&[json!(rows - 1), json!("id")], true).unwrap(),
                (rows - 1).to_string()
            );
            let index_bytes = index.metadata().unwrap().len()
                + doc
                    .branches
                    .as_ref()
                    .map(|f| f.metadata().unwrap().len())
                    .unwrap_or(0)
                + doc
                    .keys
                    .as_ref()
                    .map(|f| f.metadata().unwrap().len())
                    .unwrap_or(0)
                + doc
                    .children
                    .as_ref()
                    .map(|f| f.metadata().unwrap().len())
                    .unwrap_or(0);
            eprintln!("JSON_BENCH run={run} scalar={scalar} source_bytes={} index_bytes={index_bytes} open_ms={:.3} first_ms={:.3} last_ms={:.3}", path.metadata().unwrap().len(), open.as_secs_f64()*1000., first.as_secs_f64()*1000., last.as_secs_f64()*1000.);
            drop(doc);
        }
    }
    std::fs::remove_file(path).unwrap();
}

fn benchmark(rows: u64, runs: usize) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!("atlas-benchmark-{}-{stamp}", std::process::id()));
    let path = base.with_extension("jsonl");
    let index = base.with_extension("idx");
    {
        let mut file = BufWriter::with_capacity(256 * 1024, File::create(&path).unwrap());
        for id in 0..rows {
            writeln!(
                file,
                r#"{{"id":{id},"name":"item","active":true,"score":1,"group":"a","value":null}}"#
            )
            .unwrap();
        }
        file.flush().unwrap();
    }
    let bytes = path.metadata().unwrap().len();
    for run in 1..=runs {
        let start = Instant::now();
        let mut doc = Indexed::open(
            path.to_str().unwrap(),
            index.clone(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        let open = start.elapsed();
        assert_eq!(doc.info(true, false).unwrap()["records"], rows);
        let start = Instant::now();
        let first = doc.page(&[], 0, None, 100, false, true).unwrap();
        let first_time = start.elapsed();
        let start = Instant::now();
        let last = doc.page(&[], rows - 100, None, 100, false, true).unwrap();
        let last_time = start.elapsed();
        assert_eq!(first["items"].as_array().unwrap().len(), 100);
        assert_eq!(last["items"][99]["key"], rows - 1);
        assert_eq!(
            doc.text(&[json!(rows - 1), json!("id")], true).unwrap(),
            (rows - 1).to_string()
        );
        eprintln!("JSONL_BENCH run={run} rows={rows} source_bytes={bytes} index_bytes={} open_ms={:.3} first_ms={:.3} last_ms={:.3}",
        index.metadata().unwrap().len(),open.as_secs_f64()*1000.,first_time.as_secs_f64()*1000.,last_time.as_secs_f64()*1000.);
        drop(doc);
        assert!(!index.exists());
    }
    std::fs::remove_file(path).unwrap();
}
