//! Sample rate conversion for interleaved stereo audio (rubato, FFT based).

use rubato::{FftFixedIn, Resampler};

const CHUNK: usize = 1024;

/// Converts a continuous stream of interleaved stereo frames from one rate to another.
pub struct StereoResampler {
    inner: Option<FftFixedIn<f32>>,
    pending: [Vec<f32>; 2],
}

impl StereoResampler {
    pub fn new(from: u32, to: u32) -> anyhow::Result<Self> {
        let inner = if from == to { None } else { Some(FftFixedIn::<f32>::new(from as usize, to as usize, CHUNK, 2, 2)?) };
        Ok(Self { inner, pending: [Vec::new(), Vec::new()] })
    }

    /// Feeds interleaved frames and appends whatever is ready (interleaved) to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let Some(r) = self.inner.as_mut() else {
            out.extend_from_slice(input);
            return;
        };
        for frame in input.chunks_exact(2) {
            self.pending[0].push(frame[0]);
            self.pending[1].push(frame[1]);
        }
        loop {
            let need = r.input_frames_next();
            if self.pending[0].len() < need {
                break;
            }
            let chunk = [self.pending[0][..need].to_vec(), self.pending[1][..need].to_vec()];
            self.pending[0].drain(..need);
            self.pending[1].drain(..need);
            if let Ok(res) = r.process(&chunk, None) {
                for i in 0..res[0].len() {
                    out.push(res[0][i]);
                    out.push(res[1][i]);
                }
            }
        }
    }
}

/// Converts a whole file at once (cart wall), flushing the tail.
pub fn resample_all(input: &[f32], from: u32, to: u32) -> anyhow::Result<Vec<f32>> {
    if from == to {
        return Ok(input.to_vec());
    }
    let mut r = StereoResampler::new(from, to)?;
    let mut out = Vec::with_capacity((input.len() as u64 * to as u64 / from as u64) as usize + CHUNK * 4);
    r.process(input, &mut out);
    // Push silence through so the last samples come out, then cut to the expected length.
    let expected = (input.len() / 2) as u64 * to as u64 / from as u64;
    let delay = r.inner.as_ref().map_or(0, |i| i.output_delay());
    r.process(&vec![0.0; (CHUNK * 4 + delay) * 2], &mut out);
    out.drain(..(delay * 2).min(out.len()));
    out.truncate(expected as usize * 2);
    Ok(out)
}
