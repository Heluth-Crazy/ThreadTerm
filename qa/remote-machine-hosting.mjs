// Slice 5 extends the basic harness before its revoke/gate-off checks.
process.env.THREADTERM_QA_MACHINE_HOSTING = '1';
await import('./remote-machine-basic.mjs');
