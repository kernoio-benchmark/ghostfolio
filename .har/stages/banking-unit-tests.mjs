// banking-unit-tests — banking-change line, station S2.
// Every spec in the banking territory passes (Jest --ci), and a banking
// source change ships with a spec change. Territory: ../triggers.json.
import { unitProveStage } from './lib/factory-line.mjs';

await unitProveStage('banking-unit-tests', 'banking-change');
