use std::{
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const WRITE_SLICE_BYTES: usize = 4 * 1024;

enum WriterMessage {
    Bytes(Vec<u8>),
    Stop,
}

pub(crate) struct PriorityWriter {
    high: SyncSender<WriterMessage>,
    normal: SyncSender<WriterMessage>,
    cancelled: Arc<AtomicBool>,
    _join: JoinHandle<io::Result<()>>,
}

impl PriorityWriter {
    pub(crate) fn start(
        writer: Box<dyn Write + Send>,
        high_capacity: usize,
        normal_capacity: usize,
    ) -> io::Result<Self> {
        if high_capacity == 0 || normal_capacity == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "writer capacities must be non-zero",
            ));
        }
        let (high, high_rx) = mpsc::sync_channel(high_capacity);
        let (normal, normal_rx) = mpsc::sync_channel(normal_capacity);
        let cancelled = Arc::new(AtomicBool::new(false));
        let writer_cancelled = Arc::clone(&cancelled);
        let join = thread::Builder::new()
            .name("terminal-host-pty-writer".to_owned())
            .spawn(move || writer_main(writer, high_rx, normal_rx, writer_cancelled))?;
        Ok(Self {
            high,
            normal,
            cancelled,
            _join: join,
        })
    }

    pub(crate) fn send_input(&self, bytes: Vec<u8>) -> io::Result<()> {
        send(&self.normal, WriterMessage::Bytes(bytes))
    }

    pub(crate) fn send_protocol(&self, bytes: Vec<u8>) -> io::Result<()> {
        send(&self.high, WriterMessage::Bytes(bytes))
    }

    pub(crate) fn stop(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.high.try_send(WriterMessage::Stop);
    }
}

impl Drop for PriorityWriter {
    fn drop(&mut self) {
        self.stop();
    }
}

fn send(sender: &SyncSender<WriterMessage>, message: WriterMessage) -> io::Result<()> {
    sender.try_send(message).map_err(|error| match error {
        TrySendError::Full(_) => io::Error::new(io::ErrorKind::WouldBlock, "writer queue full"),
        TrySendError::Disconnected(_) => {
            io::Error::new(io::ErrorKind::BrokenPipe, "writer stopped")
        }
    })
}

fn writer_main(
    mut writer: Box<dyn Write + Send>,
    high: Receiver<WriterMessage>,
    normal: Receiver<WriterMessage>,
    cancelled: Arc<AtomicBool>,
) -> io::Result<()> {
    while !cancelled.load(Ordering::Acquire) {
        match high.try_recv() {
            Ok(message) => {
                if !write_message(&mut writer, message, &high, &cancelled)? {
                    return Ok(());
                }
                continue;
            }
            Err(TryRecvError::Disconnected) | Err(TryRecvError::Empty) => {}
        }
        match normal.recv_timeout(Duration::from_millis(5)) {
            Ok(message) => {
                if !write_message(&mut writer, message, &high, &cancelled)? {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
    Ok(())
}

fn write_message(
    writer: &mut dyn Write,
    message: WriterMessage,
    high: &Receiver<WriterMessage>,
    cancelled: &AtomicBool,
) -> io::Result<bool> {
    let WriterMessage::Bytes(bytes) = message else {
        return Ok(false);
    };
    for chunk in bytes.chunks(WRITE_SLICE_BYTES) {
        if cancelled.load(Ordering::Acquire) {
            return Ok(false);
        }
        writer.write_all(chunk)?;
        while let Ok(priority) = high.try_recv() {
            match priority {
                WriterMessage::Bytes(bytes) => writer.write_all(&bytes)?,
                WriterMessage::Stop => return Ok(false),
            }
        }
    }
    writer.flush()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::{Arc, Condvar, Mutex},
        thread,
        time::Duration,
    };

    use super::PriorityWriter;

    #[derive(Default)]
    struct State {
        writes: Vec<Vec<u8>>,
        first_write: bool,
        released: bool,
    }

    struct BlockingWriter {
        shared: Arc<(Mutex<State>, Condvar)>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let (state, ready) = &*self.shared;
            let mut state = state.lock().unwrap();
            state.writes.push(bytes.to_vec());
            if !state.first_write {
                state.first_write = true;
                ready.notify_all();
                while !state.released {
                    state = ready.wait(state).unwrap();
                }
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn protocol_write_preempts_sliced_input() {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let writer = PriorityWriter::start(
            Box::new(BlockingWriter {
                shared: Arc::clone(&shared),
            }),
            2,
            2,
        )
        .unwrap();
        writer.send_input(vec![b'n'; 8 * 1024]).unwrap();
        let (state_lock, ready) = &*shared;
        let mut state = state_lock.lock().unwrap();
        while !state.first_write {
            let (next, _) = ready.wait_timeout(state, Duration::from_secs(1)).unwrap();
            state = next;
        }
        drop(state);
        writer.send_protocol(b"HIGH".to_vec()).unwrap();
        let mut state = state_lock.lock().unwrap();
        state.released = true;
        ready.notify_all();
        drop(state);
        thread::sleep(Duration::from_millis(30));
        writer.stop();
        let state = state_lock.lock().unwrap();
        assert_eq!(state.writes[0], vec![b'n'; 4 * 1024]);
        assert_eq!(state.writes[1], b"HIGH");
        assert_eq!(state.writes[2], vec![b'n'; 4 * 1024]);
    }

    #[test]
    fn stop_is_nonblocking_while_underlying_write_is_blocked() {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let writer = PriorityWriter::start(
            Box::new(BlockingWriter {
                shared: Arc::clone(&shared),
            }),
            1,
            1,
        )
        .unwrap();
        writer.send_input(vec![b'n'; 4 * 1024]).unwrap();
        let (state_lock, ready) = &*shared;
        let mut state = state_lock.lock().unwrap();
        while !state.first_write {
            let (next, _) = ready.wait_timeout(state, Duration::from_secs(1)).unwrap();
            state = next;
        }
        drop(state);
        let started = std::time::Instant::now();
        writer.stop();
        assert!(started.elapsed() < Duration::from_millis(50));
        let mut state = state_lock.lock().unwrap();
        state.released = true;
        ready.notify_all();
    }
}
