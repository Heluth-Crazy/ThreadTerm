// Slice 4a extends the same isolated two-runtime/one-desktop pairing harness.
process.env.THREADTERM_QA_MACHINE_BROWSER = '1';
await import('./remote-machine-basic.mjs');
