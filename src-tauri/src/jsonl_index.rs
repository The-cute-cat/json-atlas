//! JSONL has one 4/8-byte entry per valid record, not one entry per JSON field.
//! Ordinary rows are validated while scanning and parsed locally on demand.
//! Oversized rows use a streaming subtree index, keeping memory bounded.
use super::{err, Indexed, NodeBuffer, Result, Scanner, PREVIEW, TEXT_LIMIT};
use memchr::memchr;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offset_widths_and_long_tags_round_trip_without_truncation() {
        assert_eq!(entry_width((1 << 31) - 1), 4);
        assert_eq!(entry_width(1 << 31), 8);
        assert_eq!(entry_width((1u64 << 32) + 17), 8);
        for (width, tags) in [
            (4, vec![0, LONG32 - 1, LONG, LONG | 12345]),
            (
                8,
                vec![LONG32, (1u64 << 32) + 17, LONG | ((1u64 << 32) + 7)],
            ),
        ] {
            let mut bytes = Vec::new();
            for tag in &tags {
                write_tag(&mut bytes, *tag, width).unwrap();
            }
            assert_eq!(
                bytes.chunks_exact(width).map(read_tag).collect::<Vec<_>>(),
                tags
            );
        }
        assert!(write_tag(&mut Vec::new(), LONG32, 4).is_err());
    }
    #[test]
    fn failed_index_writes_are_errors_instead_of_bad_jsonl_records() {
        struct Failing;
        impl Write for Failing {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("simulated disk failure"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(write_tag(&mut Failing, 0, 4)
            .unwrap_err()
            .contains("disk failure"));
        assert!(write_tag(&mut Failing, LONG | 42, 8)
            .unwrap_err()
            .contains("disk failure"));
    }
}

const ROW_LIMIT: usize = 64 * 1024;
const LONG: u64 = 1 << 63;
const LONG32: u64 = 1 << 31;

fn entry_width(size: u64) -> usize {
    if size < LONG32 {
        4
    } else {
        8
    }
}
fn write_tag(writer: &mut impl Write, tag: u64, width: usize) -> Result<()> {
    if width == 4 {
        let payload = tag & !LONG;
        if payload >= LONG32 {
            return Err("记录偏移超出原文件大小，请重新打开".into());
        }
        let raw = (payload | if tag & LONG != 0 { LONG32 } else { 0 }) as u32;
        writer.write_all(&raw.to_le_bytes()).map_err(err)
    } else {
        writer.write_all(&tag.to_le_bytes()).map_err(err)
    }
}
fn read_tag(bytes: &[u8]) -> u64 {
    if bytes.len() == 4 {
        let raw = u32::from_le_bytes(bytes.try_into().unwrap()) as u64;
        if raw & LONG32 != 0 {
            LONG | (raw & !LONG32)
        } else {
            raw
        }
    } else {
        u64::from_le_bytes(bytes.try_into().unwrap())
    }
}

pub(super) struct LineIndex {
    reader: BufReader<File>,
    cursor: u64,
    offsets: File,
    pub(super) records: u64,
    pub(super) bad: u64,
    pub(super) comments: u64,
    long: Option<Indexed>,
    long_nodes: u64,
    cached: Option<(u64, Arc<Value>)>,
    width: usize,
}

fn trimmed(mut bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes = &bytes[3..];
    }
    bytes.trim_ascii()
}
fn describe(value: &Value, path: &[Value]) -> Value {
    let (kind, count) = match value {
        Value::Object(v) => ("object", v.len()),
        Value::Array(v) => ("array", v.len()),
        Value::String(_) => ("string", 0),
        Value::Null => ("null", 0),
        Value::Bool(_) => ("boolean", 0),
        Value::Number(_) => ("number", 0),
    };
    let mut result = json!({"path":path,"type":kind,"childCount":count});
    if count == 0 && !value.is_object() && !value.is_array() {
        let truncated = value.as_str().is_some_and(|s| s.len() > PREVIEW as usize);
        result["value"] = if truncated {
            let text = value.as_str().unwrap();
            let mut end = PREVIEW as usize;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            json!(format!("{}…", &text[..end]))
        } else {
            value.clone()
        };
        result["truncated"] = json!(truncated);
    }
    result
}
fn at<'a>(mut value: &'a Value, path: &[Value]) -> Result<&'a Value> {
    for key in path {
        value = match value {
            Value::Object(map) => key.as_str().and_then(|key| map.get(key)),
            Value::Array(array) => key
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .and_then(|n| array.get(n)),
            _ => None,
        }
        .ok_or("节点不存在")?;
    }
    Ok(value)
}

impl LineIndex {
    pub(super) fn build(
        path: &Path,
        offsets: &File,
        long_path: PathBuf,
        cancel: &AtomicBool,
        progress: &dyn Fn(u64),
    ) -> Result<Self> {
        let source = File::open(path).map_err(err)?;
        let size = source.metadata().map_err(err)?.len();
        if size >= LONG {
            return Err("JSONL 文件超过 64 位偏移表支持范围".into());
        }
        let mut result = Self {
            reader: BufReader::with_capacity(256 * 1024, source),
            cursor: 0,
            offsets: offsets.try_clone().map_err(err)?,
            records: 0,
            bad: 0,
            comments: 0,
            long: None,
            long_nodes: 0,
            cached: None,
            width: entry_width(size),
        };
        result.offsets.rewind().map_err(err)?;
        let mut writer =
            BufWriter::with_capacity(256 * 1024, result.offsets.try_clone().map_err(err)?);
        let mut line = Vec::with_capacity(ROW_LIMIT);
        let mut large = false;
        let mut start = 0;
        let mut next_progress = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            let buf = result.reader.fill_buf().map_err(err)?;
            if buf.is_empty() {
                break;
            }
            let newline = memchr(b'\n', buf);
            let count = newline.unwrap_or(buf.len());
            let keep = (ROW_LIMIT - line.len()).min(count);
            line.extend_from_slice(&buf[..keep]);
            if keep < count {
                large = true;
            }
            let consumed = count + usize::from(newline.is_some());
            result.reader.consume(consumed);
            result.cursor += consumed as u64;
            if result.cursor >= next_progress {
                progress(result.cursor);
                next_progress = result.cursor + 256 * 1024;
                if cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
            }
            if newline.is_some() {
                if let Some(tag) = result.validate(path, &long_path, start, &line, large, cancel)? {
                    write_tag(&mut writer, tag, result.width)?;
                    result.records += 1;
                }
                line.clear();
                large = false;
                start = result.cursor;
            }
        }
        if !line.is_empty() || large {
            if let Some(tag) = result.validate(path, &long_path, start, &line, large, cancel)? {
                write_tag(&mut writer, tag, result.width)?;
                result.records += 1;
            }
        }
        writer.flush().map_err(err)?;
        drop(writer);
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if result.records == 0 {
            return Err("JSONL 内没有可解析的记录".into());
        }
        progress(result.cursor);
        Ok(result)
    }
    fn validate(
        &mut self,
        path: &Path,
        long_path: &Path,
        start: u64,
        line: &[u8],
        large: bool,
        cancel: &AtomicBool,
    ) -> Result<Option<u64>> {
        let body = trimmed(line);
        if body.starts_with(b"#") || body.starts_with(b"//") {
            self.comments += 1;
            return Ok(None);
        }
        if !large {
            if body.is_empty() {
                return Ok(None);
            }
            if serde_json::from_slice::<Value>(body).is_ok() {
                return Ok(Some(start));
            }
            self.bad += 1;
            return Ok(None);
        }
        // A giant blank line is legal; scanner.space() validates this without
        // allocating the line. All large-row parser I/O errors remain fatal.
        if self.long.is_none() {
            self.long = Some(Indexed::empty(
                path.to_str().ok_or("文件路径不是有效 Unicode")?,
                long_path.to_path_buf(),
            )?);
        }
        let long = self.long.as_mut().unwrap();
        let mut input = File::open(path).map_err(err)?;
        input.seek(SeekFrom::Start(start)).map_err(err)?;
        let before = self.long_nodes;
        let mut scanner = Scanner {
            input: BufReader::with_capacity(256 * 1024, input),
            index: long.index.as_mut().unwrap(),
            buffer: NodeBuffer::new(long.width),
            pos: start,
            nodes: before,
            cancel,
            progress: &|_| {},
            next_progress: start,
            line_mode: true,
            io_failed: false,
        };
        if scanner.peek()? == Some(0xEF) {
            for b in [0xEF, 0xBB, 0xBF] {
                scanner.expect(b)?;
            }
        }
        scanner.space()?;
        if matches!(scanner.peek()?, None | Some(b'\n')) {
            return Ok(None);
        }
        if scanner.peek()? == Some(b'#') {
            self.comments += 1;
            return Ok(None);
        }
        if scanner.peek()? == Some(b'/') {
            scanner.byte()?;
            if scanner.peek()? == Some(b'/') {
                self.comments += 1;
                return Ok(None);
            }
            self.bad += 1;
            return Ok(None);
        }
        let parsed = scanner.value(0, 0, 0).and_then(|id| {
            scanner.space()?;
            if scanner.peek()?.is_some_and(|b| b != b'\n') {
                Err("记录后存在多余内容".into())
            } else {
                Ok(id)
            }
        });
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if scanner.io_failed {
            return Err(parsed.err().unwrap_or_else(|| "索引 I/O 失败".into()));
        }
        match parsed {
            Ok(id) => {
                self.long_nodes = scanner.nodes;
                scanner.buffer.flush(scanner.index)?;
                long.build_children(before, self.long_nodes, cancel)?;
                Ok(Some(LONG | id))
            }
            Err(_) => {
                scanner
                    .index
                    .set_len(before * scanner.buffer.record())
                    .map_err(err)?;
                self.bad += 1;
                Ok(None)
            }
        }
    }
    fn tags(&mut self, start: u64, count: u64) -> Result<Vec<u64>> {
        if start > self.records || count > self.records - start || count > 100 {
            return Err("无效的记录范围".into());
        }
        self.offsets
            .seek(SeekFrom::Start(start * self.width as u64))
            .map_err(err)?;
        let mut bytes = vec![0; count as usize * self.width];
        self.offsets.read_exact(&mut bytes).map_err(err)?;
        Ok(bytes.chunks_exact(self.width).map(read_tag).collect())
    }
    fn tag(&mut self, row: u64) -> Result<u64> {
        if row >= self.records {
            return Err("节点不存在".into());
        }
        Ok(self.tags(row, 1)?[0])
    }
    fn raw(&mut self, start: u64) -> Result<Vec<u8>> {
        // seek_relative is avoided here: tracking the logical cursor lets
        // sequential pages consume the current buffer without any seek syscall.
        if start >= self.cursor && start - self.cursor <= self.reader.buffer().len() as u64 {
            self.reader.consume((start - self.cursor) as usize);
        } else {
            self.reader.seek(SeekFrom::Start(start)).map_err(err)?;
        }
        self.cursor = start;
        let mut bytes = Vec::new();
        loop {
            let buf = self.reader.fill_buf().map_err(err)?;
            if buf.is_empty() {
                break;
            }
            let newline = memchr(b'\n', buf);
            let count = newline.unwrap_or(buf.len());
            if bytes.len() + count > ROW_LIMIT {
                return Err("文件内容与行索引不一致，请重新打开".into());
            }
            bytes.extend_from_slice(&buf[..count]);
            let consumed = count + usize::from(newline.is_some());
            self.reader.consume(consumed);
            self.cursor += consumed as u64;
            if newline.is_some() {
                break;
            }
        }
        Ok(trimmed(&bytes).to_vec())
    }
    fn value(&mut self, row: u64, tag: u64) -> Result<Arc<Value>> {
        if let Some((cached, value)) = &self.cached {
            if *cached == row {
                return Ok(value.clone());
            }
        }
        let value: Arc<Value> = Arc::new(serde_json::from_slice(&self.raw(tag)?).map_err(err)?);
        self.cached = Some((row, value.clone()));
        Ok(value)
    }
    fn long_row(&mut self, tag: u64) -> Result<&mut Indexed> {
        let long = self.long.as_mut().ok_or("长记录索引不存在")?;
        long.root = tag & !LONG;
        Ok(long)
    }
    fn row_description(&mut self, row: u64, tag: u64, path: &[Value]) -> Result<Value> {
        if tag & LONG != 0 {
            let long = self.long_row(tag)?;
            return long.describe(long.root, path);
        }
        let value = self.value(row, tag)?;
        Ok(describe(&value, path))
    }
    fn wrapped(&self, wrap: bool) -> bool {
        wrap && self.records > 1
    }
    fn split<'a>(&self, path: &'a [Value], wrap: bool) -> Result<Option<(u64, &'a [Value])>> {
        if self.wrapped(wrap) {
            if path.is_empty() {
                return Ok(None);
            }
            let row = path[0]
                .as_u64()
                .filter(|n| *n < self.records)
                .ok_or("节点不存在")?;
            Ok(Some((row, &path[1..])))
        } else {
            Ok(Some((0, path)))
        }
    }
    pub(super) fn root(&mut self, wrap: bool) -> Result<Value> {
        if self.wrapped(wrap) {
            return Ok(json!({"path":[],"type":"array","childCount":self.records}));
        }
        let tag = self.tag(0)?;
        self.row_description(0, tag, &[])
    }
    pub(super) fn page(
        &mut self,
        path: &[Value],
        offset: u64,
        key: Option<&Value>,
        limit: u64,
        first: bool,
        wrap: bool,
    ) -> Result<Value> {
        let Some((row, inner)) = self.split(path, wrap)? else {
            let total = if first {
                self.records.min(1)
            } else {
                self.records
            };
            let selected = match key {
                Some(key) => key.as_u64().filter(|n| *n < total).ok_or("节点不存在")?,
                None => offset,
            };
            let start = selected.min(total.saturating_sub(1)) / limit * limit;
            let end = (start + limit).min(total);
            let tags = self.tags(start, end - start)?;
            let mut items = Vec::new();
            for (index, tag) in tags.into_iter().enumerate() {
                let row = start + index as u64;
                let child_path = vec![json!(row)];
                let mut d = self.row_description(row, tag, &child_path)?;
                d["key"] = json!(row);
                d["arrayItem"] = json!(true);
                items.push(d);
            }
            return Ok(json!({"start":start,"end":end,"total":total,"items":items}));
        };
        let tag = self.tag(row)?;
        if tag & LONG != 0 {
            let mut page = self
                .long_row(tag)?
                .page(inner, offset, key, limit, first, true)?;
            for item in page["items"].as_array_mut().unwrap() {
                let mut p = path.to_vec();
                p.push(item["key"].clone());
                item["path"] = json!(p);
            }
            return Ok(page);
        }
        let value = self.value(row, tag)?;
        let value = at(&value, inner)?;
        let array = value.is_array();
        let total = match value {
            Value::Array(v) => {
                if first {
                    v.len().min(1)
                } else {
                    v.len()
                }
            }
            Value::Object(v) => v.len(),
            _ => 0,
        } as u64;
        let selected = match key {
            Some(key) if array => key.as_u64().filter(|n| *n < total).ok_or("节点不存在")?,
            Some(key) => value
                .as_object()
                .and_then(|m| m.keys().position(|k| Some(k.as_str()) == key.as_str()))
                .map(|n| n as u64)
                .ok_or("节点不存在")?,
            None => offset,
        };
        let start = selected.min(total.saturating_sub(1)) / limit * limit;
        let end = (start + limit).min(total);
        let mut items = Vec::new();
        if let Some(v) = value.as_array() {
            for index in start..end {
                let k = json!(index);
                let mut p = path.to_vec();
                p.push(k.clone());
                let mut d = describe(&v[index as usize], &p);
                d["key"] = k;
                d["arrayItem"] = json!(true);
                items.push(d);
            }
        } else if let Some(v) = value.as_object() {
            for (k, v) in v.iter().skip(start as usize).take((end - start) as usize) {
                let mut p = path.to_vec();
                p.push(json!(k));
                let mut d = describe(v, &p);
                d["key"] = json!(k);
                d["arrayItem"] = json!(false);
                items.push(d);
            }
        }
        Ok(json!({"start":start,"end":end,"total":total,"items":items}))
    }
    fn row_json(&mut self, tag: u64) -> Result<Vec<u8>> {
        if tag & LONG != 0 {
            let long = self.long_row(tag)?;
            let n = long.node(long.root)?;
            long.bytes(n.start, n.end, TEXT_LIMIT)
        } else {
            self.raw(tag)
        }
    }
    pub(super) fn text(&mut self, path: &[Value], wrap: bool) -> Result<String> {
        let Some((row, inner)) = self.split(path, wrap)? else {
            let mut text = String::from("[");
            let mut row = 0;
            while row < self.records {
                let tags = self.tags(row, (self.records - row).min(100))?;
                for tag in tags {
                    let bytes = self.row_json(tag)?;
                    if text.len() as u64 + bytes.len() as u64 + 2 > TEXT_LIMIT {
                        return Err("内容过大，暂不支持全文读取或复制（上限 8 MiB）".into());
                    }
                    if row > 0 {
                        text.push(',');
                    }
                    text.push_str(std::str::from_utf8(&bytes).map_err(err)?);
                    row += 1;
                }
            }
            text.push(']');
            return Ok(text);
        };
        let tag = self.tag(row)?;
        if tag & LONG != 0 {
            return self.long_row(tag)?.text(inner, true);
        }
        let value = self.value(row, tag)?;
        let value = at(&value, inner)?;
        if let Value::String(text) = value {
            return Ok(text.clone());
        }
        if inner.is_empty() {
            return String::from_utf8(self.raw(tag)?).map_err(err);
        }
        serde_json::to_string(value).map_err(err)
    }
}
