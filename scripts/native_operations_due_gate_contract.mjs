import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const dueGateContract = JSON.parse(readFileSync(new URL('./native_operations_due_gate_contract.json', import.meta.url), 'utf8'));
export function verifyNativeOperationsDueGateContract(read = (file) => readFileSync(new URL(`../${file}`, import.meta.url))) {
  if (dueGateContract.version !== 1 || !dueGateContract.sha256['src/lib/nativeOperations.ts']
    || !dueGateContract.sha256['src/lib/installationRequestDelivery.ts']
    || !dueGateContract.sha256['src/lib/nativeAlexaEvents.ts']) throw new Error('Incomplete native operations due gate contract');
  for (const [file, expected] of Object.entries(dueGateContract.sha256)) {
    const actual = createHash('sha256').update(read(file)).digest('hex');
    if (actual !== expected) throw new Error(`Native operations due gate compatibility review required: ${file}`);
  }
  return Object.keys(dueGateContract.sha256).length;
}
