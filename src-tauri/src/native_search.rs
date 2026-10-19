//! Search uses independent read handles and bounded buffers, never the UI page cache.
use super::*;
use serde::Deserialize;
use std::{borrow::Cow, collections::HashSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub search_id: String,
    pub query: String,
    #[serde(default = "root_label")]
    root_label: String,
    #[serde(default)]
    index_base: u64,
    #[serde(default)]
    hidden: HashSet<String>,
    #[serde(default = "limit")]
    limit: usize,
    #[serde(default = "yes")]
    pub wrap: bool,
    #[serde(default)]
    native_pattern: Option<String>,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    scope_path: Option<Vec<Value>>,
}
fn root_label() -> String {
    "root".into()
}
fn limit() -> usize {
    1000
}
fn yes() -> bool {
    true
}

pub(super) struct Search<'a> {
    options: &'a Options,
    cancel: &'a AtomicBool,
    hits: Vec<Vec<Value>>,
    pattern: Pattern,
    visited: u64,
}
impl Search<'_> {
    pub(super) fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("已取消".into())
        } else {
            Ok(())
        }
    }
    pub(super) fn visible(&mut self, path: &[Value]) -> Result<bool> {
        self.check()?;
        self.visited += 1;
        let relevant = self
            .options
            .scope_path
            .as_ref()
            .is_none_or(|scope| path.starts_with(scope) || scope.starts_with(path));
        // Path formatting is only needed when something can actually be hidden.
        let hidden =
            !self.options.hidden.is_empty() && self.options.hidden.contains(&normalized(path));
        Ok(relevant && !hidden)
    }
    fn accept(&mut self, path: &[Value], matched: bool) -> bool {
        if matched
            && self
                .options
                .scope_path
                .as_ref()
                .is_none_or(|scope| path.starts_with(scope))
        {
            self.hits.push(path.to_vec());
        }
        self.hits.len() >= self.options.limit
    }
    pub(super) fn root_label(&self) -> String {
        self.options.root_label.clone()
    }
    pub(super) fn index_label(&self, index: u64) -> String {
        (index + self.options.index_base).to_string()
    }
    pub(super) fn array_root(&mut self, label: &str) -> Result<bool> {
        let matched = self.matches(label, "array")?;
        Ok(self.accept(&[], matched))
    }
    fn matches(&mut self, label: &str, text: &str) -> Result<bool> {
        let mut matcher = Matcher::new(&mut self.pattern);
        matcher.feed_checked(label, self.cancel)?;
        matcher.feed(' ');
        matcher.feed_checked(text, self.cancel)?;
        Ok(matcher.finish())
    }
    pub(super) fn value(
        &mut self,
        value: &Value,
        path: &mut Vec<Value>,
        label: &str,
    ) -> Result<bool> {
        if !self.visible(path)? {
            return Ok(false);
        }
        // Borrow scalar text where possible: this runs once per visited node.
        let text: Cow<'_, str> = match value {
            Value::Object(_) => Cow::Borrowed("object"),
            Value::Array(_) => Cow::Borrowed("array"),
            Value::String(s) => Cow::Borrowed(s.as_str()),
            Value::Number(n) => Cow::Owned(number(n.as_f64().ok_or("无效数字")?)),
            _ => Cow::Owned(value.to_string()),
        };
        let matched = self.matches(label, text.as_ref())?;
        if self.accept(path, matched) {
            return Ok(true);
        }
        match value {
            Value::Array(values) => {
                for (i, v) in values.iter().enumerate() {
                    path.push(json!(i));
                    let stop = self.value(v, path, &self.index_label(i as u64))?;
                    path.pop();
                    if stop {
                        return Ok(true);
                    }
                }
            }
            Value::Object(values) => {
                for (k, v) in values {
                    path.push(json!(k));
                    let stop = self.value(v, path, k)?;
                    path.pop();
                    if stop {
                        return Ok(true);
                    }
                }
            }
            _ => {}
        }
        Ok(false)
    }
    pub(super) fn indexed(
        &mut self,
        doc: &mut Indexed,
        path: &mut Vec<Value>,
        label: &str,
    ) -> Result<bool> {
        let mut input = Input::new(&doc.source_path)?;
        self.node(doc, &mut input, doc.root, path, label, path.len(), false)
            .map(|v| v.1)
    }
    fn node(
        &mut self,
        doc: &mut Indexed,
        input: &mut Input,
        id: u64,
        path: &mut Vec<Value>,
        label: &str,
        prefix: usize,
        object_child: bool,
    ) -> Result<(u64, bool)> {
        let node = Node::read(
            doc.index.as_mut().ok_or("索引已关闭")?,
            &mut doc.node_buffer,
            id,
        )?;
        if !self.visible(path)? {
            return Ok((node.next, false));
        }
        if self.visited % 4096 == 0 {
            doc.check()?;
        }
        let matched = if node.kind == 3 {
            // Preserve ambiguity errors for long duplicate-key values.
            if object_child && node.end - node.start > PREVIEW {
                doc.resolve(&path[prefix..], true)?;
            }
            input.string(node.start, node.end, label, &mut self.pattern, self.cancel)?
        } else {
            let text = match node.kind {
                1 => "object".into(),
                2 => "array".into(),
                4 => input.raw(node.start, node.end)?,
                5 => "null".into(),
                6 => {
                    let raw = input.raw(node.start, node.end)?;
                    number(serde_json::from_str::<f64>(&raw).map_err(err)?)
                }
                _ => return Err("节点类型无效".into()),
            };
            self.matches(label, &text)?
        };
        if self.accept(path, matched) {
            return Ok((node.next, true));
        }
        if node.kind == 1 || node.kind == 2 {
            if object_child && node.count > 0 {
                doc.resolve(&path[prefix..], true)?;
            }
            let mut child = id + 1;
            for i in 0..node.count {
                let (key, label) = if node.kind == 2 {
                    (json!(i), self.index_label(i))
                } else {
                    let n = Node::read(doc.index.as_mut().unwrap(), &mut doc.node_buffer, child)?;
                    let key: String = serde_json::from_str(&input.raw(n.ks, n.ke)?).map_err(err)?;
                    (json!(key), key)
                };
                path.push(key);
                let (next, stop) =
                    self.node(doc, input, child, path, &label, prefix, node.kind == 1)?;
                path.pop();
                child = next;
                if stop {
                    return Ok((node.next, true));
                }
            }
        }
        Ok((node.next, false))
    }
}
impl Indexed {
    pub fn native_search(&mut self, options: &Options, cancel: &AtomicBool) -> Result<Value> {
        if !(1..=1000).contains(&options.limit)
            || options.index_base > 1
            || options.query.is_empty()
            || options.query.len() > 64 * 1024
            || options
                .scope_path
                .as_ref()
                .is_some_and(|path| path.len() > 128)
        {
            return Err("无效的搜索参数".into());
        }
        self.check()?;
        let mut search = Search {
            options,
            cancel,
            hits: Vec::new(),
            pattern: Pattern::configured(options)?,
            visited: 0,
        };
        search.check()?;
        let truncated = if let Some(lines) = self.jsonl.as_mut() {
            lines.native_search(&mut search, options.wrap)?
        } else {
            search.indexed(self, &mut Vec::new(), &options.root_label)?
        };
        search.check()?;
        self.check()?;
        Ok(json!({"hits":search.hits,"truncated":truncated}))
    }
}

fn normalized(path: &[Value]) -> String {
    let mut out = "$".to_string();
    for key in path {
        if let Some(key) = key.as_str() {
            if !key.is_empty()
                && key.bytes().enumerate().all(|(i, b)| {
                    b.is_ascii_alphabetic() || b == b'_' || b == b'$' || i > 0 && b.is_ascii_digit()
                })
            {
                out.push('.');
                out.push_str(key);
            } else {
                out.push('[');
                out.push_str(&json!(key).to_string());
                out.push(']');
            }
        } else {
            out.push_str("[0]");
        }
    }
    out
}

// JS renders numbers as IEEE-754 values, using exponent notation outside [1e-6,1e21).
fn number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if !value.is_finite() {
        return if value.is_sign_negative() {
            "-Infinity"
        } else {
            "Infinity"
        }
        .into();
    }
    let raw = value.abs().to_string();
    let (mantissa, exponent) = raw
        .split_once('e')
        .map_or((raw.as_str(), 0), |(m, e)| (m, e.parse::<i32>().unwrap()));
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    let leading = digits.bytes().take_while(|b| *b == b'0').count();
    digits.drain(..leading);
    let decimal = point + exponent - leading as i32;
    while digits.ends_with('0') {
        digits.pop();
    }
    // Rust's Display rounds an exact shortest-decimal tie away from zero;
    // ECMAScript chooses the even decimal significand. Compare the midpoint
    // exactly using the binary mantissa, without a second rounded f64 test.
    let significand: u64 = digits.parse().unwrap();
    if significand % 2 == 1 && decimal_tie(value.abs(), significand, decimal - digits.len() as i32)
    {
        digits = (significand - 1).to_string();
    }
    let mut out = if value.is_sign_negative() {
        "-".to_string()
    } else {
        String::new()
    };
    if decimal > 21 || decimal <= -6 {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let exp = decimal - 1;
        out.push('e');
        if exp >= 0 {
            out.push('+');
        }
        out.push_str(&exp.to_string());
    } else if decimal <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat((-decimal) as usize));
        out.push_str(&digits);
    } else if decimal as usize >= digits.len() {
        out.push_str(&digits);
        out.push_str(&"0".repeat(decimal as usize - digits.len()));
    } else {
        let (a, b) = digits.split_at(decimal as usize);
        out.push_str(a);
        out.push('.');
        out.push_str(b);
    }
    out
}

fn decimal_tie(value: f64, significand: u64, scale: i32) -> bool {
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
    let zeros = mantissa.trailing_zeros();
    let binary = mantissa >> zeros;
    let power = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    } + zeros as i32;
    if power != scale - 1 {
        return false;
    }
    let mut midpoint = 2 * significand as u128 - 1;
    if scale >= 0 {
        for _ in 0..scale {
            let Some(next) = midpoint.checked_mul(5) else {
                return false;
            };
            midpoint = next;
        }
    } else {
        for _ in scale..0 {
            if midpoint % 5 != 0 {
                return false;
            }
            midpoint /= 5;
        }
    }
    midpoint == binary as u128
}

struct Input {
    reader: BufReader<File>,
    pos: u64,
}
impl Input {
    fn new(path: &Path) -> Result<Self> {
        Ok(Self {
            reader: BufReader::with_capacity(256 * 1024, File::open(path).map_err(err)?),
            pos: 0,
        })
    }
    fn seek(&mut self, pos: u64) -> Result<()> {
        if pos >= self.pos && pos - self.pos <= self.reader.buffer().len() as u64 {
            self.reader.consume((pos - self.pos) as usize);
        } else {
            self.reader.seek(SeekFrom::Start(pos)).map_err(err)?;
        }
        self.pos = pos;
        Ok(())
    }
    fn raw(&mut self, start: u64, end: u64) -> Result<String> {
        let len = end
            .checked_sub(start)
            .filter(|n| *n <= 64 * 1024)
            .ok_or("索引值范围无效")?;
        self.seek(start)?;
        let mut bytes = vec![0; len as usize];
        self.reader.read_exact(&mut bytes).map_err(err)?;
        self.pos = end;
        String::from_utf8(bytes).map_err(err)
    }
    fn byte(&mut self, end: u64) -> Result<u8> {
        if self.pos >= end {
            return Err("字符串索引不完整".into());
        }
        let mut b = [0];
        self.reader.read_exact(&mut b).map_err(err)?;
        self.pos += 1;
        Ok(b[0])
    }
    fn hex(&mut self, end: u64) -> Result<u32> {
        let mut value = 0;
        for _ in 0..4 {
            let b = self.byte(end)?;
            value = value * 16 + (b as char).to_digit(16).ok_or("无效的 Unicode 转义")?;
        }
        Ok(value)
    }
    fn escaped(&mut self, end: u64) -> Result<char> {
        Ok(match self.byte(end)? {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                let first = self.hex(end)?;
                let code = if (0xd800..=0xdbff).contains(&first) {
                    if self.byte(end)? != b'\\' || self.byte(end)? != b'u' {
                        return Err("无效的 Unicode 代理对".into());
                    }
                    let second = self.hex(end)?;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return Err("无效的 Unicode 代理对".into());
                    }
                    0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                } else {
                    first
                };
                char::from_u32(code).ok_or("无效的 Unicode 字符")?
            }
            _ => return Err("无效的字符串转义".into()),
        })
    }
    fn string(
        &mut self,
        start: u64,
        end: u64,
        label: &str,
        pattern: &mut Pattern,
        cancel: &AtomicBool,
    ) -> Result<bool> {
        // Validate the indexed range first: a stale index must not wrap `end - 1`.
        let end = end
            .checked_sub(1)
            .filter(|end| *end > start)
            .ok_or("字符串索引不完整")?;
        self.seek(start + 1)?;
        let mut matcher = Matcher::new(pattern);
        matcher.feed_checked(label, cancel)?;
        matcher.feed(' ');
        while self.pos < end && !matcher.matched() {
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            let bytes = self.reader.fill_buf().map_err(err)?;
            if bytes.is_empty() {
                return Err("字符串索引不完整".into());
            }
            let len = bytes.len().min((end - self.pos) as usize);
            let len = memchr::memchr(b'\\', &bytes[..len]).unwrap_or(len);
            if len > 0 {
                let text = match std::str::from_utf8(&bytes[..len]) {
                    Ok(text) => text,
                    Err(e) if e.error_len().is_none() => {
                        std::str::from_utf8(&bytes[..e.valid_up_to()]).map_err(err)?
                    }
                    Err(e) => return Err(err(e)),
                };
                let consumed = text.len();
                matcher.feed_checked(text, cancel)?;
                self.reader.consume(consumed);
                self.pos += consumed as u64;
                if consumed > 0 {
                    continue;
                }
                // A UTF-8 code point straddles two I/O blocks.
                let first = self.byte(end)?;
                let n = if first < 0xe0 {
                    2
                } else if first < 0xf0 {
                    3
                } else {
                    4
                };
                let mut code = [0; 4];
                code[0] = first;
                for b in &mut code[1..n] {
                    *b = self.byte(end)?;
                }
                matcher.feed(
                    std::str::from_utf8(&code[..n])
                        .map_err(err)?
                        .chars()
                        .next()
                        .unwrap(),
                );
            } else {
                self.byte(end)?;
                matcher.feed(self.escaped(end)?);
            }
        }
        Ok(matcher.finish())
    }
}

struct Pattern {
    units: Vec<u16>,
    failure: Vec<usize>,
    greek: bool,
    classes: Vec<u8>,
    advanced: Option<super::search_regex::Pattern>,
}
impl Pattern {
    fn configured(options: &Options) -> Result<Self> {
        let mut pattern = Self::new(&options.query);
        if let Some(source) = &options.native_pattern {
            pattern.advanced = Some(super::search_regex::Pattern::new(
                source,
                options.case_sensitive,
            )?);
        }
        Ok(pattern)
    }
    fn new(query: &str) -> Self {
        let units: Vec<_> = query.encode_utf16().collect();
        let mut failure = vec![0; units.len()];
        for i in 1..units.len() {
            let mut j = failure[i - 1];
            while j > 0 && units[i] != units[j] {
                j = failure[j - 1];
            }
            if units[i] == units[j] {
                j += 1;
            }
            failure[i] = j;
        }
        Self {
            units,
            failure,
            greek: query.contains(['σ', 'ς']),
            classes: Vec::new(),
            advanced: None,
        }
    }
    fn class(&mut self, c: char) -> u8 {
        if c.is_ascii_alphabetic() {
            return 1;
        }
        let i = c as usize;
        if self.classes.len() <= i {
            self.classes.resize(i + 1, 0);
        }
        if self.classes[i] == 0 {
            // Rust's contextual lowercasing supplies the Unicode Cased and
            // Case_Ignorable properties, including characters with both flags.
            self.classes[i] = if format!("{c}Σ!").to_lowercase().ends_with("ς!") {
                1
            } else if format!("AΣ{c}A").to_lowercase().starts_with("aσ") {
                2
            } else {
                3
            };
        }
        self.classes[i]
    }
}
#[derive(Clone, Copy, Default)]
struct State {
    cursor: usize,
    hit: bool,
}
impl State {
    fn feed(&mut self, c: char, p: &Pattern) {
        // An empty pattern has no table entries and can never match.
        if self.hit || p.units.is_empty() {
            return;
        }
        for unit in c.encode_utf16(&mut [0; 2]).iter() {
            while self.cursor > 0 && p.units[self.cursor] != *unit {
                self.cursor = p.failure[self.cursor - 1];
            }
            if p.units[self.cursor] == *unit {
                self.cursor += 1;
            }
            if self.cursor == p.units.len() {
                self.hit = true;
                return;
            }
        }
    }
}
enum Matcher<'a> {
    Literal(LiteralMatcher<'a>),
    Advanced(super::search_regex::Matcher<'a>),
}
impl<'a> Matcher<'a> {
    fn new(pattern: &'a mut Pattern) -> Self {
        if pattern.advanced.is_some() {
            Self::Advanced(super::search_regex::Matcher::new(
                pattern.advanced.as_ref().unwrap(),
            ))
        } else {
            Self::Literal(LiteralMatcher::new(pattern))
        }
    }
    fn matched(&self) -> bool {
        match self {
            Self::Literal(m) => m.matched(),
            Self::Advanced(m) => m.matched(),
        }
    }
    fn feed_str(&mut self, text: &str) {
        match self {
            Self::Literal(m) => m.feed_str(text),
            Self::Advanced(m) => m.feed_str(text),
        }
    }
    fn feed_checked(&mut self, text: &str, cancel: &AtomicBool) -> Result<()> {
        if let Self::Advanced(m) = self {
            for (i, c) in text.chars().enumerate() {
                if i % 32 == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                m.feed(c);
                if m.matched() {
                    break;
                }
            }
        } else {
            self.feed_str(text);
        }
        Ok(())
    }
    fn feed(&mut self, c: char) {
        match self {
            Self::Literal(m) => m.feed(c),
            Self::Advanced(m) => m.feed(c),
        }
    }
    fn finish(self) -> bool {
        match self {
            Self::Literal(m) => m.finish(),
            Self::Advanced(m) => m.finish(),
        }
    }
}
struct LiteralMatcher<'a> {
    pattern: &'a mut Pattern,
    state: State,
    pending: Option<(State, State)>,
    previous: bool,
}
impl<'a> LiteralMatcher<'a> {
    fn new(pattern: &'a mut Pattern) -> Self {
        Self {
            pattern,
            state: State::default(),
            pending: None,
            previous: false,
        }
    }
    fn matched(&self) -> bool {
        self.pending.map_or(self.state.hit, |(a, b)| a.hit && b.hit)
    }
    fn feed_str(&mut self, text: &str) {
        for c in text.chars() {
            self.feed(c);
            if self.matched() {
                break;
            }
        }
    }
    fn feed(&mut self, c: char) {
        if self.matched() {
            return;
        }
        let class = if self.pattern.greek {
            self.pattern.class(c)
        } else {
            3
        };
        if class != 2 {
            if let Some((final_sigma, ordinary)) = self.pending.take() {
                self.state = if class == 1 { ordinary } else { final_sigma };
            }
        }
        if c == 'Σ' && self.pattern.greek && self.previous {
            let (mut a, mut b) = (self.state, self.state);
            a.feed('ς', self.pattern);
            b.feed('σ', self.pattern);
            self.pending = Some((a, b));
        } else {
            for lower in c.to_lowercase() {
                if let Some((a, b)) = self.pending.as_mut() {
                    a.feed(lower, self.pattern);
                    b.feed(lower, self.pattern);
                } else {
                    self.state.feed(lower, self.pattern);
                }
            }
        }
        if class != 2 {
            self.previous = class == 1;
        }
    }
    fn finish(self) -> bool {
        self.pending.map_or(self.state.hit, |(a, _)| a.hit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    fn run(text: &str, ext: &str, f: impl FnOnce(&mut Indexed)) {
        let base = std::env::temp_dir().join(format!(
            "atlas-search-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let path = base.with_extension(ext);
        let index = base.with_extension("idx");
        std::fs::write(&path, text).unwrap();
        let mut doc = Indexed::open(
            path.to_str().unwrap(),
            index.clone(),
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        f(&mut doc);
        drop(doc);
        assert!(!index.exists());
        std::fs::remove_file(path).unwrap();
    }
    fn options(query: &str) -> Options {
        serde_json::from_value(json!({"searchId":"test","query":query})).unwrap()
    }
    fn search(doc: &mut Indexed, query: &str) -> Value {
        doc.native_search(&options(query), &AtomicBool::new(false))
            .unwrap()
    }
    #[test]
    fn javascript_differential_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/native-search-fixtures.json")).unwrap();
        for case in cases {
            let options: Options = serde_json::from_value(case["options"].clone()).unwrap();
            for ext in ["json", "jsonl"] {
                run(case["text"].as_str().unwrap(), ext, |doc| {
                    assert_eq!(
                        doc.native_search(&options, &AtomicBool::new(false))
                            .unwrap(),
                        case["expected"],
                        "options={}",
                        case["options"]
                    );
                });
            }
        }
    }
    #[test]
    fn javascript_numeric_rendering_differential() {
        let cases: Vec<(String, String)> =
            serde_json::from_str(include_str!("../../tests/native-search-numbers.json")).unwrap();
        for (raw, expected) in cases {
            assert_eq!(
                number(serde_json::from_str::<f64>(&raw).unwrap()),
                expected,
                "{raw}"
            );
        }
    }
    #[test]
    fn stream_long_values_escapes_boundaries_and_jsonl_roots() {
        let value = format!(
            "{}中\\u6587\\ud83d\\ude00TAIL",
            "x".repeat(8 * 1024 * 1024 + 262142)
        );
        for ext in ["json", "jsonl"] {
            run(
                &format!(r#"{{"long":"{value}","end":"yes"}}"#),
                ext,
                |doc| {
                    let mut copy = doc.search_copy().unwrap();
                    assert_eq!(search(&mut copy, "中文😀tail")["hits"], json!([["long"]]));
                    let mut regex = options("TAIL$");
                    regex.native_pattern = Some("TAIL$".into());
                    regex.case_sensitive = true;
                    assert_eq!(
                        copy.native_search(&regex, &AtomicBool::new(false)).unwrap()["hits"],
                        json!([["long"]])
                    );
                    assert!(doc.text(&[json!("long")], true).is_err());
                    assert_eq!(
                        doc.page(&[], 0, None, 100, false, true).unwrap()["total"],
                        2
                    );
                    drop(copy);
                    assert!(doc.index_path.exists());
                },
            );
        }
        run(
            "{\"s\":\"first\"}\n{\"s\":\"tail\"}\nbad\n",
            "jsonl",
            |doc| {
                assert_eq!(search(doc, "tail")["hits"], json!([[1, "s"]]));
                let mut opts = options("tail");
                opts.wrap = false;
                assert_eq!(
                    doc.native_search(&opts, &AtomicBool::new(false)).unwrap()["hits"],
                    json!([])
                );
                opts.query = "first".into();
                assert_eq!(
                    doc.native_search(&opts, &AtomicBool::new(false)).unwrap()["hits"],
                    json!([["s"]])
                );
            },
        );
    }
    #[test]
    fn contextual_sigma_and_kmp_match_whole_string_lowercasing() {
        for text in [
            "ΟΣ",
            "ΟΣΑ",
            "Σ",
            "AΣ\u{301}",
            "AΣ\u{301}A",
            "AΣ'A",
            "AΣ.A",
            "AΣ\u{345}A",
            "AΣΣ",
            "İ😀Σ",
            "AΣ\u{200d}A",
            "AΣ\u{30000}",
        ] {
            let lower = text.to_lowercase();
            let queries = [
                "ος",
                "οσ",
                "σ",
                "ς",
                "σ'",
                "ς'",
                "σ\u{301}a",
                "i\u{307}",
                "😀",
            ];
            for query in queries {
                let mut pattern = Pattern::new(query);
                let mut matcher = Matcher::new(&mut pattern);
                // Feed one code point at a time so all context crosses boundaries.
                for c in text.chars() {
                    matcher.feed(c);
                }
                assert_eq!(
                    matcher.finish(),
                    lower.contains(query),
                    "{text:?}/{query:?}"
                );
            }
        }
        let mut p = Pattern::new("ababac");
        let mut m = Matcher::new(&mut p);
        m.feed_str("ababababac");
        assert!(m.finish());
    }
    #[test]
    fn streaming_decoder_matches_across_every_small_buffer_boundary() {
        let text = r#""AΣ\u0301'A 中\u6587\ud83d\ude00 \\ \" TAIL""#;
        let value: String = serde_json::from_str(text).unwrap();
        run(text, "json", |doc| {
            for size in 1..=17 {
                for query in ["σ\u{301}'a", "ς", "中文😀", "\\ \" tail", "missing"] {
                    let mut input = Input {
                        reader: BufReader::with_capacity(
                            size,
                            File::open(&doc.source_path).unwrap(),
                        ),
                        pos: 0,
                    };
                    let mut pattern = Pattern::new(query);
                    assert_eq!(
                        input
                            .string(
                                0,
                                text.len() as u64,
                                "root",
                                &mut pattern,
                                &AtomicBool::new(false)
                            )
                            .unwrap(),
                        format!("root {value}").to_lowercase().contains(query),
                        "size={size} query={query}"
                    );
                }
            }
        });
    }
    #[test]
    fn cancellation_lifecycle_and_independent_read_handles() {
        run(r#"{"rows":[{"v":"target"},{"v":"end"}]}"#, "json", |doc| {
            let mut copy = doc.search_copy().unwrap();
            let cancelled = AtomicBool::new(true);
            assert!(copy
                .native_search(&options("target"), &cancelled)
                .unwrap_err()
                .contains("取消"));
            assert_eq!(
                search(&mut copy, "target")["hits"],
                json!([["rows", 0, "v"]])
            );
            assert_eq!(
                doc.text(&[json!("rows"), json!(1), json!("v")], true)
                    .unwrap(),
                "end"
            );
        });
        let state = IndexState::default();
        run("[1,2]", "json", |doc| {
            state.sessions.lock().unwrap().insert(
                "doc".into(),
                Arc::new(Mutex::new(doc.search_copy().unwrap())),
            );
            let first = state.begin_search("doc", "one").unwrap();
            let second = state.begin_search("doc", "two").unwrap();
            assert!(first.cancel.load(Ordering::Relaxed));
            state.cancel_search("doc", "two").unwrap();
            assert!(second.cancel.load(Ordering::Relaxed));
            let third = state.begin_search("doc", "three").unwrap();
            state.close_session("doc").unwrap();
            assert!(third.cancel.load(Ordering::Relaxed));
            assert!(state.begin_search("doc", "four").is_err());
            drop(first);
            drop(second);
            drop(third);
            assert!(state.searches.lock().unwrap().is_empty());
        });
    }
    #[test]
    fn file_changes_and_duplicate_branch_paths_are_errors() {
        run(r#"{"a":{"s":"first"},"a":{"s":"second"}}"#, "json", |doc| {
            assert!(doc
                .native_search(&options("missing"), &AtomicBool::new(false))
                .is_err());
            let mut opt = options("object");
            opt.limit = 1;
            assert_eq!(
                doc.native_search(&opt, &AtomicBool::new(false)).unwrap()["hits"],
                json!([[]])
            );
            let mut copy = doc.search_copy().unwrap();
            std::fs::write(&doc.source_path, "{}").unwrap();
            assert!(copy.native_search(&opt, &AtomicBool::new(false)).is_err());
        });
    }
}
