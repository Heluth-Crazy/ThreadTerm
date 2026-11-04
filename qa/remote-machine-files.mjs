// Slice 3 extends the same isolated two-runtime/one-desktop pairing harness as slice 2.
process.env.THREADTERM_QA_MACHINE_FILES = '1';
await import('./remote-machine-basic.mjs');
