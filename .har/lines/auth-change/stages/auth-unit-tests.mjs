// auth-unit-tests — auth-change line, station S2.
// Every spec in the auth territory passes (Jest --ci), and an auth source
// change ships with a spec change. Territory: ../triggers.json.
import { unitProveStage } from './lib/factory-line.mjs';

await unitProveStage('auth-unit-tests', 'auth-change');
