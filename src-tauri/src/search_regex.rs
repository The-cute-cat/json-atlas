//! Thompson simulation on streaming UTF-8, bounded by the compiled expression.
//! Only previous/current code points are needed for anchors and word assertions.
use regex_automata::{
    nfa::thompson::{self, State, NFA},
    util::{look::Look, primitives::StateID, syntax},
};

pub(super) struct Pattern {
    nfa: NFA,
    insensitive: bool,
}
impl Pattern {
    pub fn new(source: &str, case_sensitive: bool) -> Result<Self, String> {
        if source.len() > 128 * 1024 {
            return Err("正则表达式过长".into());
        }
        let nfa = NFA::compiler()
            .configure(
                thompson::Config::new()
                    .nfa_size_limit(Some(2 * 1024 * 1024))
                    .which_captures(thompson::WhichCaptures::None),
            )
            .syntax(syntax::Config::new().case_insensitive(!case_sensitive))
            .build(source)
            .map_err(|e| format!("正则表达式无效或过于复杂：{e}"))?;
        Ok(Self {
            nfa,
            insensitive: !case_sensitive,
        })
    }
}
pub(super) struct Matcher<'a> {
    pattern: &'a Pattern,
    pending: Vec<StateID>,
    active: Vec<StateID>,
    stack: Vec<StateID>,
    seen: Vec<u32>,
    generation: u32,
    previous: Option<char>,
    hit: bool,
}
impl<'a> Matcher<'a> {
    pub fn new(pattern: &'a Pattern) -> Self {
        let count = pattern.nfa.states().len();
        Self {
            pattern,
            pending: Vec::new(),
            active: Vec::new(),
            stack: Vec::new(),
            seen: vec![0; count],
            generation: 0,
            previous: None,
            hit: false,
        }
    }
    pub fn matched(&self) -> bool {
        self.hit
    }
    pub fn feed_str(&mut self, text: &str) {
        for c in text.chars() {
            self.feed(c);
            if self.hit {
                break;
            }
        }
    }
    fn closure(&mut self, context: &[u8], at: usize, boundary: bool, current: Option<char>) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.seen.fill(0);
            self.generation = 1;
        }
        self.active.clear();
        self.stack.clear();
        self.stack.extend(self.pending.drain(..));
        if boundary {
            self.stack.push(self.pattern.nfa.start_anchored());
        }
        while let Some(id) = self.stack.pop() {
            if self.seen[id.as_usize()] == self.generation {
                continue;
            }
            self.seen[id.as_usize()] = self.generation;
            match self.pattern.nfa.state(id) {
                State::ByteRange { .. } | State::Sparse(_) | State::Dense(_) => {
                    self.active.push(id)
                }
                State::Look { look, next } => {
                    let satisfied = match look {
                        Look::WordAscii | Look::WordAsciiNegate => {
                            let word = |c: Option<char>| {
                                c.is_some_and(|c| {
                                    c.is_ascii_alphanumeric()
                                        || c == '_'
                                        || self.pattern.insensitive && matches!(c, 'K' | 'ſ')
                                })
                            };
                            boundary
                                && ((word(self.previous) != word(current))
                                    == (*look == Look::WordAscii))
                        }
                        _ => self.pattern.nfa.look_matcher().matches(*look, context, at),
                    };
                    if satisfied {
                        self.stack.push(*next);
                    }
                }
                State::Union { alternates } => self.stack.extend(alternates),
                State::BinaryUnion { alt1, alt2 } => {
                    self.stack.push(*alt1);
                    self.stack.push(*alt2);
                }
                State::Capture { next, .. } => self.stack.push(*next),
                State::Match { .. } => {
                    if boundary {
                        self.hit = true;
                        return;
                    }
                }
                State::Fail => {}
            }
        }
    }
    pub fn feed(&mut self, c: char) {
        if self.hit {
            return;
        }
        let mut context = [0; 8];
        let before = self
            .previous
            .map_or(0, |prev| prev.encode_utf8(&mut context[..4]).len());
        let size = c.encode_utf8(&mut context[before..]).len();
        for i in 0..size {
            self.closure(&context[..before + size], before + i, i == 0, Some(c));
            if self.hit {
                return;
            }
            let byte = context[before + i];
            for id in self.active.drain(..) {
                let next = match self.pattern.nfa.state(id) {
                    State::ByteRange { trans } => trans.matches_byte(byte).then_some(trans.next),
                    State::Sparse(trans) => trans.matches_byte(byte),
                    State::Dense(trans) => trans.matches_byte(byte),
                    _ => None,
                };
                if let Some(next) = next {
                    self.pending.push(next);
                }
            }
        }
        self.previous = Some(c);
    }
    pub fn finish(mut self) -> bool {
        if !self.hit {
            let mut context = [0; 4];
            let size = self
                .previous
                .map_or(0, |c| c.encode_utf8(&mut context).len());
            self.closure(&context[..size], size, true, None);
        }
        self.hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn matched(pattern: &str, text: &str) -> bool {
        let pattern = Pattern::new(pattern, false).unwrap();
        let mut matcher = Matcher::new(&pattern);
        for c in text.chars() {
            matcher.feed(c);
        }
        matcher.finish()
    }
    #[test]
    fn streaming_assertions_nullable_cycles_and_unicode_boundaries() {
        assert!(matched("^$", ""));
        assert!(!matched("^$", "a"));
        assert!(matched("(?:a?)*b$", "aaaaab"));
        assert!(!matched("(?:a?)*b$", "aaaaac"));
        assert!(matched(r"\b{start-half}汉字\b{end-half}", "汉字！"));
        assert!(!matched(r"\b{start-half}汉字\b{end-half}", "汉字库"));
        assert!(matched(r"(?-u:\b)k(?-u:\b)", "K"));
        assert!(!matched(r"(?-u:\bk\b)", "K"));
        assert!(matched(r"^😀+$", "😀😀"));
    }
    #[test]
    fn invalid_and_excessively_expanded_patterns_fail_with_bounded_compilation() {
        assert!(Pattern::new("[", false).is_err());
        assert!(Pattern::new("a{999999999}", false).is_err());
    }
}
