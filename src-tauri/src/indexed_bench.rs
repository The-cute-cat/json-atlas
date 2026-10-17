//! Opt-in, reproducible release benchmark. Timings exclude fixture generation.
use super::*;
use std::io::BufWriter;
use std::time::{Instant, UNIX_EPOCH};

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
#[ignore = "release I/O benchmark: ordinary JSON array with 200,000 six-field objects"]
fn json_many_fields_benchmark() {
    json_benchmark(200_000, 3);
}

#[test]
#[ignore = "release I/O benchmark: about 256 MiB ordinary JSON with six fields per item"]
fn json_256mib_benchmark() {
    json_benchmark(3_500_000, 1);
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
                .children
                .as_ref()
                .map(|f| f.metadata().unwrap().len())
                .unwrap_or(0);
        eprintln!("JSON_BENCH run={run} source_bytes={} index_bytes={index_bytes} open_ms={:.3} first_ms={:.3} last_ms={:.3}", path.metadata().unwrap().len(), open.as_secs_f64()*1000., first.as_secs_f64()*1000., last.as_secs_f64()*1000.);
        drop(doc);
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
