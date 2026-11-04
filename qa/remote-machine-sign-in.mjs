// Slice 4b reuses the isolated two-runtime pairing harness.
process.env.THREADTERM_QA_MACHINE_SIGN_IN = '1';
await import('./remote-machine-basic.mjs');
