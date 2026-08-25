use super::marker::{ReadyMarkerFilter, ReadyMarkerOutput};

/// Output observation is deliberately separate from the startup coordinator.
/// The output lock owns only parser state; readiness transitions are performed
/// by `SessionStartup` after this state has been released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartupOutputConfig {
    Passthrough,
    Marker { nonce: String, triggers_ready: bool },
    FirstOutput { triggers_ready: bool },
}

enum StartupOutputMode {
    Passthrough,
    Marker {
        filter: ReadyMarkerFilter,
        triggers_ready: bool,
    },
    FirstOutput {
        triggers_ready: bool,
    },
}

pub(crate) struct StartupOutputObserver {
    mode: StartupOutputMode,
    #[cfg(any(test, feature = "terminal-startup-harness"))]
    marker_matched: bool,
    #[cfg(any(test, feature = "terminal-startup-harness"))]
    first_output_observed: bool,
}

#[derive(Default, PartialEq, Eq)]
pub(crate) struct StartupOutputObservation {
    pub(crate) visible: Vec<u8>,
    pub(crate) matched: usize,
    pub(crate) buffered_len: usize,
    /// True only for the first matched private marker in this generation.
    #[cfg(any(test, feature = "terminal-startup-harness"))]
    pub(crate) marker_matched: bool,
    /// True only for the first non-empty ordinary output in FirstOutput mode.
    #[cfg(any(test, feature = "terminal-startup-harness"))]
    pub(crate) first_output_observed: bool,
    pub(crate) became_ready: bool,
}

impl StartupOutputObserver {
    pub(crate) fn new() -> Self {
        Self {
            mode: StartupOutputMode::Passthrough,
            #[cfg(any(test, feature = "terminal-startup-harness"))]
            marker_matched: false,
            #[cfg(any(test, feature = "terminal-startup-harness"))]
            first_output_observed: false,
        }
    }

    pub(crate) fn configure(&mut self, config: StartupOutputConfig) -> Result<(), String> {
        let mode = match config {
            StartupOutputConfig::Passthrough => StartupOutputMode::Passthrough,
            StartupOutputConfig::FirstOutput { triggers_ready } => {
                StartupOutputMode::FirstOutput { triggers_ready }
            }
            StartupOutputConfig::Marker {
                nonce,
                triggers_ready,
            } => StartupOutputMode::Marker {
                filter: ReadyMarkerFilter::new(&nonce).map_err(str::to_owned)?,
                triggers_ready,
            },
        };
        #[cfg(any(test, feature = "terminal-startup-harness"))]
        {
            self.marker_matched = false;
            self.first_output_observed = false;
        }
        self.mode = mode;
        Ok(())
    }

    pub(crate) fn observe(&mut self, bytes: &[u8]) -> StartupOutputObservation {
        let output = match &mut self.mode {
            StartupOutputMode::Passthrough | StartupOutputMode::FirstOutput { .. } => {
                ReadyMarkerOutput {
                    visible: bytes.to_vec(),
                    matched: 0,
                }
            }
            StartupOutputMode::Marker { filter, .. } => filter.consume(bytes),
        };
        self.observation_from_output(output)
    }

    pub(crate) fn finish(&mut self) -> StartupOutputObservation {
        let output = match &mut self.mode {
            StartupOutputMode::Marker { filter, .. } => filter.finish(),
            StartupOutputMode::Passthrough | StartupOutputMode::FirstOutput { .. } => {
                ReadyMarkerOutput {
                    visible: Vec::new(),
                    matched: 0,
                }
            }
        };
        self.observation_from_output(output)
    }

    pub(crate) fn discard(&mut self) {
        if let StartupOutputMode::Marker { filter, .. } = &mut self.mode {
            filter.reset();
        }
    }

    pub(crate) fn buffered_len(&self) -> usize {
        match &self.mode {
            StartupOutputMode::Marker { filter, .. } => filter.buffered_len(),
            StartupOutputMode::Passthrough | StartupOutputMode::FirstOutput { .. } => 0,
        }
    }

    pub(crate) fn marker_triggers_ready(&self) -> bool {
        matches!(
            self.mode,
            StartupOutputMode::Marker {
                triggers_ready: true,
                ..
            }
        )
    }

    pub(crate) fn first_output_triggers_ready(&self, visible: &[u8]) -> bool {
        matches!(
            self.mode,
            StartupOutputMode::FirstOutput {
                triggers_ready: true
            }
        ) && !visible.is_empty()
    }

    fn observation_from_output(&mut self, output: ReadyMarkerOutput) -> StartupOutputObservation {
        #[cfg(any(test, feature = "terminal-startup-harness"))]
        let marker_matched = output.matched > 0 && !self.marker_matched;
        #[cfg(any(test, feature = "terminal-startup-harness"))]
        if output.matched > 0 {
            self.marker_matched = true;
        }
        #[cfg(any(test, feature = "terminal-startup-harness"))]
        let first_output_observed = matches!(&self.mode, StartupOutputMode::FirstOutput { .. })
            && !output.visible.is_empty()
            && !self.first_output_observed;
        #[cfg(any(test, feature = "terminal-startup-harness"))]
        if first_output_observed {
            self.first_output_observed = true;
        }
        StartupOutputObservation {
            visible: output.visible,
            matched: output.matched,
            buffered_len: self.buffered_len(),
            #[cfg(any(test, feature = "terminal-startup-harness"))]
            marker_matched,
            #[cfg(any(test, feature = "terminal-startup-harness"))]
            first_output_observed,
            became_ready: false,
        }
    }
}

impl Default for StartupOutputObserver {
    fn default() -> Self {
        Self::new()
    }
}
