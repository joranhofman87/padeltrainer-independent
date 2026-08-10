process.on('exit', (c) => console.error('exit event', c));
const t = setTimeout(() => { console.error('STILL ALIVE after 20s — handles:', process.getActiveResourcesInfo()); process.exit(9); }, 20000);
const { checkWorkflowContract } = await import('./scripts/ci/workflow-contract.mjs');
console.error('imported ok');
const v = await checkWorkflowContract();
console.error('violations:', v.length, v);
clearTimeout(t);
