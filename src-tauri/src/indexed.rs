//! A bounded-memory JSON scanner. The preorder index lives on disk; only the
//! parser stack, fixed-size I/O buffers and one page of previews stay in memory.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};

const RECORD: u64 = 64;
const INDEX_BLOCK: usize = RECORD as usize * 4096;
const PREVIEW: u64 = 8192;
const TEXT_LIMIT: u64 = 8 * 1024 * 1024;
#[cfg(test)]
#[path = "indexed_bench.rs"]
mod benchmarks;
#[path = "jsonl_index.rs"]
mod jsonl;
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct IndexState {
    pub jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub sessions: Mutex<HashMap<String, Arc<Mutex<Indexed>>>>,
}

#[derive(Clone, Copy, Default)]
struct Node {
    start: u64,
    end: u64,
    next: u64,
    count: u64,
    ks: u64,
    ke: u64,
    kind: u64,
    // Byte offset + 1 in the child table; zero keeps the small-container chain.
    children: u64,
}

/// One fixed-size block, shared by sequential writes and ancestor backpatches.
/// No drop-time writes: parse errors may discard the pending block safely.
#[derive(Default)]
struct NodeBuffer {
    bytes: Vec<u8>,
    base: Option<u64>,
    valid: usize,
    dirty: bool,
}
impl NodeBuffer {
    fn flush(&mut self, file: &mut File) -> Result<()> {
        if self.dirty {
            file.seek(SeekFrom::Start(self.base.unwrap()))
                .map_err(err)?;
            file.write_all(&self.bytes[..self.valid]).map_err(err)?;
            self.dirty = false;
        }
        Ok(())
    }
    fn load(&mut self, file: &mut File, id: u64) -> Result<usize> {
        let pos = id.checked_mul(RECORD).ok_or("索引位置溢出")?;
        let base = pos / INDEX_BLOCK as u64 * INDEX_BLOCK as u64;
        if self.base != Some(base) {
            self.flush(file)?;
            self.bytes.resize(INDEX_BLOCK, 0);
            self.bytes.fill(0);
            file.seek(SeekFrom::Start(base)).map_err(err)?;
            self.valid = 0;
            while self.valid < INDEX_BLOCK {
                let n = file.read(&mut self.bytes[self.valid..]).map_err(err)?;
                if n == 0 {
                    break;
                }
                self.valid += n;
            }
            self.base = Some(base);
        }
        Ok((pos - base) as usize)
    }
}
impl Node {
    fn write(self, file: &mut File, buffer: &mut NodeBuffer, id: u64) -> Result<()> {
        let offset = buffer.load(file, id)?;
        let bytes = &mut buffer.bytes[offset..offset + RECORD as usize];
        for (chunk, n) in bytes.chunks_exact_mut(8).zip([
            self.start,
            self.end,
            self.next,
            self.count,
            self.ks,
            self.ke,
            self.kind,
            self.children,
        ]) {
            chunk.copy_from_slice(&n.to_le_bytes());
        }
        buffer.valid = buffer.valid.max(offset + RECORD as usize);
        buffer.dirty = true;
        Ok(())
    }
    fn read(file: &mut File, buffer: &mut NodeBuffer, id: u64) -> Result<Self> {
        let offset = buffer.load(file, id)?;
        if offset + RECORD as usize > buffer.valid {
            return Err("索引文件不完整".into());
        }
        let bytes = &buffer.bytes[offset..offset + RECORD as usize];
        let mut v = [0; 8];
        for (i, chunk) in bytes.chunks_exact(8).enumerate() {
            v[i] = u64::from_le_bytes(chunk.try_into().unwrap());
        }
        Ok(Self {
            start: v[0],
            end: v[1],
            next: v[2],
            count: v[3],
            ks: v[4],
            ke: v[5],
            kind: v[6],
            children: v[7],
        })
    }
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn stat(path: &str) -> Result<Value> {
    let path = std::fs::canonicalize(path).map_err(err)?;
    let meta = path.metadata().map_err(err)?;
    if !meta.is_file() {
        return Err("请选择文件，不能打开目录".into());
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["json", "jsonl", "ndjson", "jsonlines", "txt"].contains(&ext.as_str()) {
        return Err("只支持 JSON / JSONL / NDJSON / JSONLines / TXT 文件".into());
    }
    Ok(
        json!({"path":super::documents::display_path(&path), "name":path.file_name().unwrap_or_default().to_string_lossy(), "size":meta.len()}),
    )
}

struct Scanner<'a> {
    input: BufReader<File>,
    index: &'a mut File,
    buffer: NodeBuffer,
    pos: u64,
    nodes: u64,
    cancel: &'a AtomicBool,
    progress: &'a dyn Fn(u64),
    next_progress: u64,
    line_mode: bool,
    io_failed: bool,
}
impl Scanner<'_> {
    fn peek(&mut self) -> Result<Option<u8>> {
        Ok(self
            .input
            .fill_buf()
            .map_err(|e| {
                self.io_failed = true;
                err(e)
            })?
            .first()
            .copied())
    }
    fn byte(&mut self) -> Result<u8> {
        let b = self.peek()?.ok_or("文件意外结束")?;
        if self.line_mode && b == b'\n' {
            return Err("JSONL 记录不能跨行".into());
        }
        self.input.consume(1);
        self.pos += 1;
        if self.pos >= self.next_progress {
            if self.cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            (self.progress)(self.pos);
            self.next_progress = self.pos + 256 * 1024;
        }
        Ok(b)
    }
    fn space(&mut self) -> Result<()> {
        while let Some(b) = self.peek()? {
            if !matches!(b, b' ' | b'\t' | b'\r' | b'\n') || (self.line_mode && b == b'\n') {
                break;
            }
            self.byte()?;
        }
        Ok(())
    }
    fn expect(&mut self, b: u8) -> Result<()> {
        if self.peek()? != Some(b) {
            return Err(format!("字节 {}：JSON 语法错误", self.pos));
        }
        self.byte()?;
        Ok(())
    }
    fn hex(&mut self) -> Result<u16> {
        let mut n = 0;
        for _ in 0..4 {
            let c = self.byte()?;
            n = n * 16
                + match c {
                    b'0'..=b'9' => (c - b'0') as u16,
                    b'a'..=b'f' => (c - b'a' + 10) as u16,
                    b'A'..=b'F' => (c - b'A' + 10) as u16,
                    _ => return Err("无效的 Unicode 转义".into()),
                };
        }
        Ok(n)
    }
    fn string(&mut self) -> Result<()> {
        self.expect(b'"')?;
        loop {
            if self.line_mode && self.peek()? == Some(b'\n') {
                return Err("字符串包含未转义换行".into());
            }
            let b = self.byte()?;
            match b {
                b'"' => return Ok(()),
                0..=31 => return Err("字符串包含未转义控制字符".into()),
                b'\\' => match {
                    if self.line_mode && self.peek()? == Some(b'\n') {
                        return Err("无效的字符串转义".into());
                    }
                    self.byte()?
                } {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {}
                    b'u' => {
                        let n = self.hex()?;
                        if (0xD800..=0xDBFF).contains(&n) {
                            self.expect(b'\\')?;
                            self.expect(b'u')?;
                            if !(0xDC00..=0xDFFF).contains(&self.hex()?) {
                                return Err("无效的 Unicode 代理对".into());
                            }
                        } else if (0xDC00..=0xDFFF).contains(&n) {
                            return Err("无效的 Unicode 代理对".into());
                        }
                    }
                    _ => return Err("无效的字符串转义".into()),
                },
                128..=255 => {
                    let len = match b {
                        0xC2..=0xDF => 2,
                        0xE0..=0xEF => 3,
                        0xF0..=0xF4 => 4,
                        _ => return Err("文件不是有效 UTF-8".into()),
                    };
                    let mut bytes = [0; 4];
                    bytes[0] = b;
                    for c in bytes.iter_mut().take(len).skip(1) {
                        *c = self.byte()?;
                    }
                    std::str::from_utf8(&bytes[..len]).map_err(|_| "文件不是有效 UTF-8")?;
                }
                _ => {}
            }
        }
    }
    fn value(&mut self, depth: usize, ks: u64, ke: u64) -> Result<u64> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if depth > 128 {
            return Err("JSON 嵌套超过 128 层".into());
        }
        self.space()?;
        let id = self.nodes;
        self.nodes += 1;
        let mut node = Node {
            start: self.pos,
            ks,
            ke,
            ..Default::default()
        };
        node.kind = match self.peek()?.ok_or("缺少 JSON 值")? {
            b'{' => 1,
            b'[' => 2,
            b'"' => 3,
            b't' | b'f' => 4,
            b'n' => 5,
            b'-' | b'0'..=b'9' => 6,
            _ => return Err(format!("字节 {}：无效的 JSON 值", self.pos)),
        };
        match node.kind {
            1 | 2 => {
                self.byte()?;
                self.space()?;
                let end = if node.kind == 1 { b'}' } else { b']' };
                if self.peek()? != Some(end) {
                    loop {
                        let (ks, ke) = if node.kind == 1 {
                            self.space()?;
                            let start = self.pos;
                            self.string()?;
                            let stop = self.pos;
                            if stop - start > 64 * 1024 {
                                return Err("索引模式暂不支持超过 64 KiB 的字段名".into());
                            }
                            self.space()?;
                            self.expect(b':')?;
                            (start, stop)
                        } else {
                            (0, 0)
                        };
                        self.value(depth + 1, ks, ke)?;
                        node.count += 1;
                        self.space()?;
                        if self.peek()? == Some(end) {
                            break;
                        }
                        self.expect(b',')?;
                    }
                }
                self.expect(end)?;
            }
            3 => self.string()?,
            _ => {
                let mut token = Vec::new();
                while let Some(b) = self.peek()? {
                    if matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}') {
                        break;
                    }
                    if token.len() >= 1024 {
                        return Err("数字超过 1024 字节".into());
                    }
                    token.push(self.byte()?);
                }
                serde_json::from_slice::<Value>(&token).map_err(err)?;
            }
        }
        node.end = self.pos;
        node.next = self.nodes;
        node.write(self.index, &mut self.buffer, id).map_err(|e| {
            self.io_failed = true;
            e
        })?;
        Ok(id)
    }
}

pub struct Indexed {
    source_path: PathBuf,
    jsonl: Option<Box<jsonl::LineIndex>>,
    source: File,
    index: Option<File>,
    node_buffer: NodeBuffer,
    children: Option<File>,
    children_path: PathBuf,
    index_path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    root: u64,
    records: u64,
    bad: u64,
    comments: u64,
    kind: String,
    syntax_failed: bool,
}
impl Drop for Indexed {
    fn drop(&mut self) {
        self.jsonl.take();
        self.index.take();
        if self.children.take().is_some() {
            let _ = std::fs::remove_file(&self.children_path);
        }
        let _ = std::fs::remove_file(&self.index_path);
    }
}
impl Indexed {
    pub fn open(
        path: &str,
        index_path: PathBuf,
        cancel: &AtomicBool,
        progress: &dyn Fn(u64),
    ) -> Result<Self> {
        let mut doc = Self::empty(path, index_path)?;
        let ext = Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let jsonl = ["jsonl", "ndjson", "jsonlines"].contains(&ext.as_str());
        let first = doc.scan(jsonl, cancel, progress);
        if let Err(e) = first {
            if jsonl || cancel.load(Ordering::Relaxed) || !doc.syntax_failed {
                return Err(e);
            }
            doc.index.as_mut().unwrap().set_len(0).map_err(err)?;
            doc.scan(true, cancel, progress)
                .map_err(|fallback| format!("JSON：{e}；JSONL：{fallback}"))?;
        }
        doc.check()?;
        Ok(doc)
    }
    fn empty(path: &str, index_path: PathBuf) -> Result<Self> {
        let source = File::open(path).map_err(err)?;
        let meta = source.metadata().map_err(err)?;
        let index = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&index_path)
            .map_err(err)?;
        Ok(Self {
            source_path: PathBuf::from(path),
            jsonl: None,
            source,
            index: Some(index),
            node_buffer: NodeBuffer::default(),
            children: None,
            children_path: {
                let mut name = index_path.as_os_str().to_os_string();
                name.push(".children");
                PathBuf::from(name)
            },
            index_path,
            size: meta.len(),
            modified: meta.modified().ok(),
            root: 0,
            records: 0,
            bad: 0,
            comments: 0,
            kind: "json".into(),
            syntax_failed: false,
        })
    }
    fn scan(&mut self, jsonl: bool, cancel: &AtomicBool, progress: &dyn Fn(u64)) -> Result<()> {
        if jsonl {
            let lines = jsonl::LineIndex::build(
                &self.source_path,
                self.index.as_ref().unwrap(),
                self.index_path.with_extension("nodes"),
                cancel,
                progress,
            )?;
            self.records = lines.records;
            self.bad = lines.bad;
            self.comments = lines.comments;
            self.kind = "jsonl".into();
            self.jsonl = Some(Box::new(lines));
            return Ok(());
        }
        let mut source = self.source.try_clone().map_err(err)?;
        source.rewind().map_err(err)?;
        let mut s = Scanner {
            input: BufReader::with_capacity(256 * 1024, source),
            index: self.index.as_mut().unwrap(),
            buffer: NodeBuffer::default(),
            pos: 0,
            nodes: 0,
            cancel,
            progress,
            next_progress: 0,
            line_mode: jsonl,
            io_failed: false,
        };
        let parsed: Result<()> = (|| {
            if s.peek()? == Some(0xEF) {
                for b in [0xEF, 0xBB, 0xBF] {
                    s.expect(b)?;
                }
            }
            s.value(0, 0, 0)?;
            s.space()?;
            if s.peek()?.is_some() {
                return Err("根节点后存在多余内容".into());
            }
            Ok(())
        })();
        // Only invalid JSON may fall back to JSONL. Disk failures are fatal.
        self.syntax_failed = parsed.is_err() && !s.io_failed;
        parsed?;
        s.buffer.flush(s.index)?;
        let nodes = s.nodes;
        self.build_children(0, nodes, cancel)?;
        self.kind = "json".into();
        Ok(())
    }
    pub fn check(&self) -> Result<()> {
        let m = self.source.metadata().map_err(err)?;
        if m.len() != self.size || m.modified().ok() != self.modified {
            return Err("文件已发生变化，请重新打开以建立索引".into());
        }
        Ok(())
    }
    fn node(&mut self, id: u64) -> Result<Node> {
        Node::read(self.index.as_mut().unwrap(), &mut self.node_buffer, id)
    }
    /// A bounded-memory second pass writes contiguous IDs only for wide containers.
    fn build_children(&mut self, start: u64, end: u64, cancel: &AtomicBool) -> Result<()> {
        let file = self.index.as_mut().unwrap();
        let mut buffer = NodeBuffer::default();
        for id in start..end {
            if id % 4096 == 0 && cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            let mut node = Node::read(file, &mut buffer, id)?;
            if node.count <= 100 {
                continue;
            }
            if self.children.is_none() {
                self.children = Some(
                    OpenOptions::new()
                        .read(true)
                        .write(true)
                        .create_new(true)
                        .open(&self.children_path)
                        .map_err(err)?,
                );
            }
            let table = self.children.as_mut().unwrap();
            node.children = table.seek(SeekFrom::End(0)).map_err(err)? + 1;
            let mut writer = BufWriter::with_capacity(256 * 1024, table);
            let mut child = id + 1;
            for i in 0..node.count {
                if i % 4096 == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                writer.write_all(&child.to_le_bytes()).map_err(err)?;
                child = Node::read(file, &mut buffer, child)?.next;
            }
            writer.flush().map_err(err)?;
            node.write(file, &mut buffer, id)?;
        }
        buffer.flush(file)?;
        self.node_buffer = NodeBuffer::default();
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        Ok(())
    }
    fn child_ids(&mut self, id: u64, parent: Node, start: u64, count: u64) -> Result<Vec<u64>> {
        if start > parent.count || count > parent.count - start || count > 100 {
            return Err("无效的子节点范围".into());
        }
        if parent.children != 0 {
            let table = self.children.as_mut().ok_or("子节点索引缺失")?;
            table
                .seek(SeekFrom::Start(parent.children - 1 + start * 8))
                .map_err(err)?;
            let mut bytes = vec![0; count as usize * 8];
            table.read_exact(&mut bytes).map_err(err)?;
            return Ok(bytes
                .chunks_exact(8)
                .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
                .collect());
        }
        let mut child = id + 1;
        for _ in 0..start {
            child = self.node(child)?.next;
        }
        let mut ids = Vec::with_capacity(count as usize);
        for _ in 0..count {
            ids.push(child);
            child = self.node(child)?.next;
        }
        Ok(ids)
    }
    fn bytes(&mut self, start: u64, end: u64, limit: u64) -> Result<Vec<u8>> {
        if end < start || end - start > limit {
            return Err("内容过大，暂不支持全文读取或复制（上限 8 MiB）".into());
        }
        self.source.seek(SeekFrom::Start(start)).map_err(err)?;
        let mut bytes = vec![0; (end - start) as usize];
        self.source.read_exact(&mut bytes).map_err(err)?;
        Ok(bytes)
    }
    fn key(&mut self, n: Node) -> Result<Value> {
        serde_json::from_slice(&self.bytes(n.ks, n.ke, 64 * 1024)?).map_err(err)
    }
    fn root_id(&self, wrap: bool) -> u64 {
        if self.kind == "jsonl" && (self.records == 1 || !wrap) {
            1
        } else {
            self.root
        }
    }
    fn resolve(&mut self, path: &[Value], wrap: bool) -> Result<u64> {
        let mut id = self.root_id(wrap);
        for key in path {
            let parent = self.node(id)?;
            if parent.kind == 2 {
                let offset = key
                    .as_u64()
                    .filter(|i| *i < parent.count)
                    .ok_or("节点不存在")?;
                id = self.child_ids(id, parent, offset, 1)?[0];
                continue;
            }
            let mut found = None;
            for start in (0..parent.count).step_by(100) {
                for child in self.child_ids(id, parent, start, (parent.count - start).min(100))? {
                    let n = self.node(child)?;
                    if parent.kind == 1 && self.key(n)? == *key {
                        if found.is_some() {
                            return Err("对象包含重复字段，索引模式无法唯一定位该路径".into());
                        }
                        found = Some(child);
                    }
                }
            }
            id = found.ok_or("节点不存在")?;
        }
        Ok(id)
    }
    fn describe(&mut self, id: u64, path: &[Value]) -> Result<Value> {
        let n = self.node(id)?;
        self.describe_node(n, path)
    }
    fn describe_node(&mut self, n: Node, path: &[Value]) -> Result<Value> {
        let kind = match n.kind {
            1 => "object",
            2 => "array",
            3 => "string",
            4 => "boolean",
            5 => "null",
            _ => "number",
        };
        let mut d = json!({"path":path,"type":kind,"childCount":n.count});
        if n.kind >= 3 {
            let truncated = n.end - n.start > PREVIEW;
            let value: Value = if truncated && n.kind == 3 {
                let mut b = self.bytes(n.start, n.start + PREVIEW, PREVIEW)?;
                // Trim a partial UTF-8 character or escape at the preview boundary.
                loop {
                    let mut candidate = b.clone();
                    candidate.push(b'"');
                    if let Ok(Value::String(mut text)) = serde_json::from_slice::<Value>(&candidate)
                    {
                        text.push('…');
                        break Value::String(text);
                    }
                    if b.len() <= 1 {
                        return Err("无法读取字符串预览".into());
                    }
                    b.pop();
                }
            } else {
                serde_json::from_slice(&self.bytes(n.start, n.end, PREVIEW)?).map_err(err)?
            };
            d["value"] = value;
            d["truncated"] = json!(truncated);
        }
        Ok(d)
    }
    pub fn info(&mut self, wrap: bool, strict: bool) -> Result<Value> {
        self.check()?;
        if strict && self.kind == "jsonl" && self.bad + self.comments > 0 {
            return Err(format!(
                "严格模式下拒绝加载：{} 行不合规（含注释行）",
                self.bad + self.comments
            ));
        }
        let root = if let Some(lines) = self.jsonl.as_mut() {
            lines.root(wrap)?
        } else {
            self.describe(self.root_id(wrap), &[])?
        };
        Ok(
            json!({"root":root,"kind":self.kind,"records":self.records,"badCount":self.bad,"commentCount":self.comments}),
        )
    }
    pub fn page(
        &mut self,
        path: &[Value],
        offset: u64,
        key: Option<&Value>,
        limit: u64,
        first: bool,
        wrap: bool,
    ) -> Result<Value> {
        self.check()?;
        if !(1..=100).contains(&limit) {
            return Err("无效的分页参数".into());
        }
        if let Some(lines) = self.jsonl.as_mut() {
            let page = lines.page(path, offset, key, limit, first, wrap)?;
            self.check()?;
            return Ok(page);
        }
        let id = self.resolve(path, wrap)?;
        let parent = self.node(id)?;
        let total = if first && parent.kind == 2 {
            parent.count.min(1)
        } else {
            parent.count
        };
        let mut selected = offset;
        if let Some(key) = key {
            if parent.kind == 2 {
                selected = key.as_u64().filter(|i| *i < total).ok_or("节点不存在")?;
            } else {
                let mut found = false;
                'search: for start in (0..total).step_by(100) {
                    for (j, child) in self
                        .child_ids(id, parent, start, (total - start).min(100))?
                        .into_iter()
                        .enumerate()
                    {
                        let n = self.node(child)?;
                        if parent.kind == 1 && self.key(n)? == *key {
                            selected = start + j as u64;
                            found = true;
                            break 'search;
                        }
                    }
                }
                if !found {
                    return Err("节点不存在".into());
                }
            }
        }
        let start = selected.min(total.saturating_sub(1)) / limit * limit;
        let end = (start + limit).min(total);
        let mut items = Vec::new();
        for (j, child) in self
            .child_ids(id, parent, start, end - start)?
            .into_iter()
            .enumerate()
        {
            let i = start + j as u64;
            let n = self.node(child)?;
            let k = if parent.kind == 2 {
                json!(i)
            } else {
                self.key(n)?
            };
            let mut child_path = path.to_vec();
            child_path.push(k.clone());
            let mut d = self.describe_node(n, &child_path)?;
            d["key"] = k;
            d["arrayItem"] = json!(parent.kind == 2);
            items.push(d);
        }
        self.check()?;
        Ok(json!({"start":start,"end":end,"total":total,"items":items}))
    }
    pub fn text(&mut self, path: &[Value], wrap: bool) -> Result<String> {
        self.check()?;
        if let Some(lines) = self.jsonl.as_mut() {
            let text = lines.text(path, wrap)?;
            self.check()?;
            return Ok(text);
        }
        let id = self.resolve(path, wrap)?;
        let n = self.node(id)?;
        if self.kind == "jsonl" && id == 0 {
            let mut text = String::from("[");
            let mut child = 1;
            for i in 0..n.count {
                let c = self.node(child)?;
                if text.len() as u64 + c.end - c.start + 2 > TEXT_LIMIT {
                    return Err("内容过大，暂不支持全文读取或复制（上限 8 MiB）".into());
                }
                if i > 0 {
                    text.push(',');
                }
                text.push_str(
                    &String::from_utf8(self.bytes(c.start, c.end, TEXT_LIMIT)?).map_err(err)?,
                );
                child = c.next;
            }
            text.push(']');
            self.check()?;
            return Ok(text);
        }
        let bytes = self.bytes(n.start, n.end, TEXT_LIMIT)?;
        let text = if n.kind == 3 {
            serde_json::from_slice::<String>(&bytes).map_err(err)?
        } else {
            String::from_utf8(bytes).map_err(err)?
        };
        self.check()?;
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    fn fixture(bytes: &[u8], ext: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "atlas-index-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let path = base.with_extension(ext);
        std::fs::write(&path, bytes).unwrap();
        (path, base.with_extension("idx"))
    }
    fn run(bytes: &[u8], ext: &str, f: impl FnOnce(&mut Indexed)) {
        let (p, i) = fixture(bytes, ext);
        let mut d = Indexed::open(
            p.to_str().unwrap(),
            i.clone(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        f(&mut d);
        drop(d);
        assert!(!i.exists());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn nested_pages_and_text() {
        let text = format!(
            r#"{{"a.b":{{"items":[{}]}},"空":"你好"}}"#,
            (0..205)
                .map(|i| format!(r#"{{"v":{i}}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        run(text.as_bytes(), "json", |d| {
            assert_eq!(d.info(true, false).unwrap()["root"]["childCount"], 2);
            let page = d
                .page(&[json!("a.b"), json!("items")], 100, None, 100, false, true)
                .unwrap();
            assert_eq!(page["items"].as_array().unwrap().len(), 100);
            assert_eq!(page["items"][0]["childCount"], 1);
            assert_eq!(
                d.text(
                    &[json!("a.b"), json!("items"), json!(204), json!("v")],
                    true
                )
                .unwrap(),
                "204"
            );
            assert_eq!(d.text(&[json!("空")], true).unwrap(), "你好");
        });
    }
    #[test]
    fn wide_containers_survive_block_backpatches_and_keep_field_order() {
        let mut fields = (0..5005)
            .map(|i| format!(r#""字段.{i}":{{"v":[{i},null]}}"#))
            .collect::<Vec<_>>();
        fields.push(r#""empty":[]"#.into());
        fields.push(r#""dup":1"#.into());
        fields.push(r#""du\u0070":2"#.into());
        let text = format!("{{{}}}", fields.join(","));
        let mut child_path = None;
        run(text.as_bytes(), "json", |d| {
            assert!(d.index.as_ref().unwrap().metadata().unwrap().len() > INDEX_BLOCK as u64);
            assert!(d.children.is_some());
            child_path = Some(d.children_path.clone());
            let page = d.page(&[], u64::MAX, None, 100, false, true).unwrap();
            assert_eq!(page["start"], 5000);
            assert_eq!(page["total"], 5008);
            assert_eq!(page["items"][4]["key"], "字段.5004");
            assert_eq!(
                d.text(&[json!("字段.5004"), json!("v"), json!(0)], true)
                    .unwrap(),
                "5004"
            );
            let selected = d
                .page(&[], 0, Some(&json!("字段.5004")), 100, false, true)
                .unwrap();
            assert_eq!(selected["start"], 5000);
            assert!(d
                .text(&[json!("dup")], true)
                .unwrap_err()
                .contains("重复字段"));
            assert_eq!(
                d.page(&[json!("empty")], 0, None, 100, false, true)
                    .unwrap()["items"],
                json!([])
            );
        });
        assert!(!child_path.unwrap().exists());
    }
    #[test]
    fn wide_arrays_address_late_nested_values_and_reject_invalid_indices() {
        let text = format!(
            "[{}]",
            (0..9001)
                .map(|i| format!("[{i}]"))
                .collect::<Vec<_>>()
                .join(",")
        );
        run(text.as_bytes(), "json", |d| {
            let page = d
                .page(&[], 0, Some(&json!(9000)), 100, false, true)
                .unwrap();
            assert_eq!(page["start"], 9000);
            assert_eq!(page["items"][0]["path"], json!([9000]));
            assert_eq!(d.text(&[json!(9000), json!(0)], true).unwrap(), "9000");
            for key in [json!(9001), json!(-1), json!("0"), json!(0.5)] {
                assert!(d.text(&[key.clone()], true).is_err());
                assert!(d.page(&[], 0, Some(&key), 100, false, true).is_err());
            }
            assert_eq!(d.page(&[], 0, None, 100, true, true).unwrap()["total"], 1);
        });
    }
    #[test]
    fn child_table_failures_are_fatal_and_existing_files_are_preserved() {
        let text = format!(
            "[{}]",
            (0..101)
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let (p, i) = fixture(text.as_bytes(), "json");
        let mut name = i.as_os_str().to_os_string();
        name.push(".children");
        let children = PathBuf::from(name);
        std::fs::write(&children, b"existing").unwrap();
        assert!(Indexed::open(
            p.to_str().unwrap(),
            i.clone(),
            &AtomicBool::new(false),
            &|_| {}
        )
        .is_err());
        assert!(!i.exists());
        assert_eq!(std::fs::read(&children).unwrap(), b"existing");
        std::fs::remove_file(children).unwrap();
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn jsonl_long_wide_rows_keep_tables_after_bad_row_rollback() {
        let row = format!(
            "[{}]",
            (0..7000)
                .map(|i| format!("{{\"v\":{i}}}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(row.len() > 64 * 1024);
        let text = format!("{row}\n{}\n{row}", format!("[{}", "0,".repeat(40000)));
        let mut children = None;
        run(text.as_bytes(), "jsonl", |d| {
            assert_eq!(d.info(true, false).unwrap()["records"], 2);
            assert_eq!(d.info(true, false).unwrap()["badCount"], 1);
            for record in 0..2 {
                assert_eq!(
                    d.text(&[json!(record), json!(6999), json!("v")], true)
                        .unwrap(),
                    "6999"
                );
                assert_eq!(
                    d.page(&[json!(record)], 6900, None, 100, false, true)
                        .unwrap()["items"][99]["key"],
                    6999
                );
            }
            let mut name = d.index_path.with_extension("nodes").into_os_string();
            name.push(".children");
            children = Some(PathBuf::from(name));
        });
        assert!(!children.unwrap().exists());
    }
    #[test]
    fn duplicate_object_keys_never_silently_read_another_value() {
        run(br#"{"x":1,"x":2}"#, "json", |d| {
            let page = d.page(&[], 0, None, 100, false, true).unwrap();
            assert_eq!(page["items"][0]["value"], 1);
            assert_eq!(page["items"][1]["value"], 2);
            assert!(d
                .text(&[json!("x")], true)
                .unwrap_err()
                .contains("重复字段"));
        });
    }
    #[test]
    fn jsonl_skips_bad_lines_and_preserves_strict_and_wrap() {
        run(
            b"\xEF\xBB\xBF{\"v\":1}\r\n#comment\n{bad}\n\n[2,3]\n",
            "jsonl",
            |d| {
                assert_eq!(d.info(true, false).unwrap()["records"], 2);
                assert!(d.info(true, true).is_err());
                assert_eq!(d.info(false, false).unwrap()["root"]["type"], "object");
                assert_eq!(d.text(&[], true).unwrap(), "[{\"v\":1},[2,3]]");
            },
        );
    }
    #[test]
    fn invalid_utf8_escapes_grammar_and_cancel_cleanup() {
        for bytes in [
            b"{\"x\":\"\xFF\"}".as_slice(),
            b"[1,]",
            b"\"\\uD800\"",
            b"[01]",
            b"{\"x\":true false}",
        ] {
            let (p, i) = fixture(bytes, "json");
            assert!(Indexed::open(
                p.to_str().unwrap(),
                i.clone(),
                &AtomicBool::new(false),
                &|_| {}
            )
            .is_err());
            assert!(!i.exists());
            std::fs::remove_file(p).unwrap();
        }
        let (p, i) = fixture(b"[]", "json");
        assert!(Indexed::open(
            p.to_str().unwrap(),
            i.clone(),
            &AtomicBool::new(true),
            &|_| {}
        )
        .is_err());
        assert!(!i.exists());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_and_file_changes() {
        let value = "中文\\\"".repeat(6000);
        let text = serde_json::to_vec(&value).unwrap();
        run(&text, "json", |d| {
            let root = d.info(true, false).unwrap();
            assert_eq!(root["root"]["truncated"], true);
            assert_eq!(d.text(&[], true).unwrap(), value);
        });
        let (p, i) = fixture(b"[1]", "json");
        let mut d =
            Indexed::open(p.to_str().unwrap(), i, &AtomicBool::new(false), &|_| {}).unwrap();
        std::fs::write(&p, b"[12]").unwrap();
        assert!(d.page(&[], 0, None, 100, false, true).is_err());
        drop(d);
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn malformed_jsonl_never_consumes_the_following_record() {
        for broken in ["{\"x\":\"bad", "[1,", "\"\\u12", "\"\\", "{\"x\":"] {
            run(
                format!("{broken}\n{{\"ok\":true}}\n").as_bytes(),
                "jsonl",
                |d| {
                    assert_eq!(d.info(true, false).unwrap()["records"], 1);
                    assert_eq!(d.info(true, false).unwrap()["badCount"], 1);
                    assert_eq!(d.text(&[json!("ok")], true).unwrap(), "true");
                },
            );
        }
    }
    #[test]
    fn jsonl_offsets_are_compact_and_last_record_is_directly_addressable() {
        let text = (0..2005)
            .map(|i| format!(r#"{{"id":{i},"z":true,"a.b":[null,{{"x":"你好"}}]}}"#))
            .collect::<Vec<_>>()
            .join("\n");
        run(text.as_bytes(), "jsonl", |d| {
            assert_eq!(
                d.index.as_ref().unwrap().metadata().unwrap().len(),
                2005 * 4
            );
            let page = d
                .page(&[], 0, Some(&json!(2004)), 100, false, true)
                .unwrap();
            assert_eq!(page["start"], 2000);
            assert_eq!(page["items"][4]["key"], 2004);
            assert_eq!(page["items"][4]["path"], json!([2004]));
            assert_eq!(
                d.text(&[json!(2004), json!("a.b"), json!(1), json!("x")], true)
                    .unwrap(),
                "你好"
            );
            let fields = d.page(&[json!(2004)], 0, None, 100, false, true).unwrap();
            assert_eq!(fields["items"][0]["key"], "id");
            assert_eq!(fields["items"][1]["key"], "z");
            assert_eq!(d.page(&[], 0, None, 100, true, true).unwrap()["total"], 1);
            assert_eq!(d.text(&[json!("id")], false).unwrap(), "0");
        });
    }
    #[test]
    fn jsonl_mixed_long_records_keep_nested_paths_and_cleanup_both_files() {
        let long = json!({"text":"中文".repeat(20000),"nested":[{"ok":true}]}).to_string();
        let (p, i) = fixture(
            format!("{{\"small\":1}}\n{long}\nfalse").as_bytes(),
            "jsonl",
        );
        let nodes = i.with_extension("nodes");
        let mut d = Indexed::open(
            p.to_str().unwrap(),
            i.clone(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        assert_eq!(i.metadata().unwrap().len(), 12);
        assert!(nodes.exists());
        assert_eq!(d.info(true, false).unwrap()["root"]["childCount"], 3);
        assert_eq!(
            d.text(&[json!(1), json!("nested"), json!(0), json!("ok")], true)
                .unwrap(),
            "true"
        );
        let page = d.page(&[json!(1)], 0, None, 100, false, true).unwrap();
        assert_eq!(page["items"][0]["path"], json!([1, "text"]));
        assert_eq!(page["items"][0]["truncated"], true);
        let root: Value = serde_json::from_str(&d.text(&[], true).unwrap()).unwrap();
        assert_eq!(root.as_array().unwrap().len(), 3);
        drop(d);
        assert!(!i.exists());
        assert!(!nodes.exists());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn jsonl_long_bad_and_blank_lines_do_not_drop_following_records() {
        let text = format!(
            "{{\"ok\":1}}\n{}\n#{}\n\"{}\n{{\"ok\":2}}",
            " ".repeat(70000),
            "comment".repeat(12000),
            "bad".repeat(30000)
        );
        run(text.as_bytes(), "jsonl", |d| {
            let info = d.info(true, false).unwrap();
            assert_eq!(info["records"], 2);
            assert_eq!(info["badCount"], 1);
            assert_eq!(info["commentCount"], 1);
            assert_eq!(d.text(&[json!(1), json!("ok")], true).unwrap(), "2");
            assert!(d.info(true, true).is_err());
        });
    }
    #[test]
    fn jsonl_fast_boundary_and_large_strings_preserve_utf8_preview() {
        let small = serde_json::to_string(&"x".repeat(65534)).unwrap();
        let large = serde_json::to_string(&"x".repeat(65535)).unwrap();
        assert_eq!(small.len(), 65536);
        assert_eq!(large.len(), 65537);
        run(
            format!("{small}\n{large}\n\"\\uD800\"\n{{\"tail\":true}}").as_bytes(),
            "jsonl",
            |d| {
                assert_eq!(d.info(true, false).unwrap()["records"], 3);
                assert_eq!(d.info(true, false).unwrap()["badCount"], 1);
                assert_eq!(d.text(&[json!(0)], true).unwrap().len(), 65534);
                assert_eq!(d.text(&[json!(1)], true).unwrap().len(), 65535);
                assert_eq!(d.text(&[json!(2), json!("tail")], true).unwrap(), "true");
            },
        );
    }
    #[test]
    fn jsonl_single_roots_fallback_and_duplicate_fields_match_memory_semantics() {
        for (input, kind, text) in [
            ("false", "boolean", "false"),
            ("null", "null", "null"),
            ("\"hello\\nworld\"", "string", "hello\nworld"),
            ("1e+4", "number", "1e+4"),
        ] {
            run(input.as_bytes(), "jsonl", |d| {
                assert_eq!(d.info(true, false).unwrap()["root"]["type"], kind);
                assert_eq!(d.text(&[], true).unwrap(), text);
            });
        }
        run(b"{\"x\":1,\"x\":2}\n{\"x\":3}", "txt", |d| {
            assert_eq!(d.info(true, false).unwrap()["kind"], "jsonl");
            assert_eq!(d.index.as_ref().unwrap().metadata().unwrap().len(), 8);
            assert_eq!(d.text(&[json!(0), json!("x")], true).unwrap(), "2");
        });
    }
    #[test]
    fn jsonl_cancellation_and_file_changes_reject_stale_reads() {
        let text = "{\"x\":1}\n".repeat(100000);
        let (p, i) = fixture(text.as_bytes(), "jsonl");
        let cancel = AtomicBool::new(false);
        assert!(
            Indexed::open(p.to_str().unwrap(), i.clone(), &cancel, &|bytes| {
                if bytes > 256 * 1024 {
                    cancel.store(true, Ordering::Relaxed);
                }
            })
            .is_err()
        );
        assert!(!i.exists());
        assert!(!i.with_extension("nodes").exists());
        let mut d = Indexed::open(
            p.to_str().unwrap(),
            i.clone(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        d.text(&[json!(0), json!("x")], true).unwrap();
        std::fs::write(&p, b"null").unwrap();
        assert!(d.text(&[json!(0), json!("x")], true).is_err());
        drop(d);
        assert!(!i.exists());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn cancellation_during_scanning_removes_partial_index() {
        let (p, i) = fixture(
            format!("\"{}\"", "x".repeat(1024 * 1024)).as_bytes(),
            "json",
        );
        let cancel = AtomicBool::new(false);
        let result = Indexed::open(p.to_str().unwrap(), i.clone(), &cancel, &|bytes| {
            if bytes > 256 * 1024 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(result.is_err());
        assert!(!i.exists());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    #[ignore = "32 MiB+ disk integration test; run explicitly"]
    fn large_document_disk_integration() {
        for ext in ["json", "jsonl"] {
            let (p, i) = fixture(b"", ext);
            let mut file = File::create(&p).unwrap();
            if ext == "json" {
                file.write_all(b"[").unwrap();
            }
            let record = serde_json::to_vec(&json!({"text":"中文".repeat(6000)})).unwrap();
            for n in 0..1000 {
                if ext == "json" && n > 0 {
                    file.write_all(b",").unwrap();
                }
                file.write_all(&record).unwrap();
                if ext == "jsonl" {
                    file.write_all(b"\n").unwrap();
                }
            }
            if ext == "json" {
                file.write_all(b"]").unwrap();
            }
            drop(file);
            assert!(p.metadata().unwrap().len() > 32 * 1024 * 1024);
            let start = std::time::Instant::now();
            let mut d = Indexed::open(
                p.to_str().unwrap(),
                i.clone(),
                &AtomicBool::new(false),
                &|_| {},
            )
            .unwrap();
            assert_eq!(d.info(true, false).unwrap()["root"]["childCount"], 1000);
            let page = d.page(&[], 900, None, 100, false, true).unwrap();
            assert_eq!(page["items"].as_array().unwrap().len(), 100);
            assert_eq!(
                d.page(&[json!(999)], 0, None, 100, false, true).unwrap()["items"][0]["truncated"],
                true
            );
            eprintln!(
                "{ext}: {} bytes, index {} bytes, elapsed {:?}",
                p.metadata().unwrap().len(),
                i.metadata().unwrap().len(),
                start.elapsed()
            );
            drop(d);
            assert!(!i.exists());
            std::fs::remove_file(p).unwrap();
        }
    }
}
