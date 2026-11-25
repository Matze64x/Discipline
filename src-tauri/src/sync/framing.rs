//! Messages over the data channel are split into frames, since browsers limit a data channel
//! message's size: each frame is text starting with `+` (more frames follow) or `.` (the last
//! one). Frames are split at character boundaries, so each is valid UTF-8 text.

/// The largest frame's payload in bytes (well below every browser's limit)
pub const FRAME_PAYLOAD: usize = 16 * 1024;

pub fn split(message: &str) -> Vec<String> {
    let mut frames = Vec::new();
    let mut rest = message;
    loop {
        if rest.len() <= FRAME_PAYLOAD {
            frames.push(format!(".{rest}"));
            return frames;
        }
        let mut cut = FRAME_PAYLOAD;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        frames.push(format!("+{}", &rest[..cut]));
        rest = &rest[cut..];
    }
}

/// Puts frames back together, refusing messages larger than `limit` bytes.
pub struct Reassembler {
    buffer: String,
    limit: usize,
}

#[derive(Debug, PartialEq)]
pub enum FrameError {
    TooLarge,
    Malformed,
}

impl Reassembler {
    pub fn new(limit: usize) -> Self {
        Reassembler { buffer: String::new(), limit }
    }

    pub fn set_limit(&mut self, limit: usize) {
        self.limit = limit;
    }

    /// Adds a frame; returns the message when it's complete.
    pub fn push(&mut self, frame: &str) -> Result<Option<String>, FrameError> {
        let (more, payload) = match frame.as_bytes().first() {
            Some(b'+') => (true, &frame[1..]),
            Some(b'.') => (false, &frame[1..]),
            _ => return Err(FrameError::Malformed),
        };
        if self.buffer.len() + payload.len() > self.limit {
            return Err(FrameError::TooLarge);
        }
        self.buffer.push_str(payload);
        Ok(if more { None } else { Some(std::mem::take(&mut self.buffer)) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_any_size_and_keeps_characters_whole() {
        let mut long = "x".repeat(FRAME_PAYLOAD - 1);
        long.push('€'); // 3 bytes across the frame border
        long.push_str(&"ü".repeat(FRAME_PAYLOAD));
        for message in ["", "short", &long, &"a".repeat(FRAME_PAYLOAD), &"a".repeat(FRAME_PAYLOAD + 1)] {
            let frames = split(message);
            assert!(frames.iter().all(|f| f.len() <= FRAME_PAYLOAD + 1));
            let mut r = Reassembler::new(usize::MAX);
            let mut out = None;
            for (i, f) in frames.iter().enumerate() {
                out = r.push(f).unwrap();
                assert_eq!(out.is_some(), i == frames.len() - 1);
            }
            assert_eq!(out.as_deref(), Some(message));
        }
    }

    #[test]
    fn refuses_too_large_and_malformed() {
        let mut r = Reassembler::new(10);
        assert_eq!(r.push("+123456"), Ok(None));
        assert_eq!(r.push(".123456"), Err(FrameError::TooLarge));
        assert_eq!(Reassembler::new(10).push("x"), Err(FrameError::Malformed));
        assert_eq!(Reassembler::new(10).push(""), Err(FrameError::Malformed));
    }
}
