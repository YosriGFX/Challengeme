// replay.mjs — check a match record. The cartridge is deterministic: the same inputs on
// the same ticks give the same game, so a record can be run again by anybody.
//
//   curl http://localhost:8787/api/log/dama/ROOM1 > match.json
//   node host/replay.mjs match.json
//
// It prints the two hashes a ledger would hold for this match (see evm/MatchLedger.sol)
// and says whether running the record again ends in the same picture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match } from './match.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rec = JSON.parse(fs.readFileSync(process.argv[2] || 0, 'utf8'));
const wasm = fs.readFileSync(path.join(root, 'dist', String(rec.cart).replace(/[^a-z0-9_-]/g, '') + '.wasm'));
const sha = (bytes) => '0x' + crypto.createHash('sha256').update(bytes).digest('hex');

const digest = await Match.replay(wasm, rec);
console.log('cartridge  ' + sha(wasm));
console.log('log        ' + sha(JSON.stringify(rec.log)) + `  (${rec.log.length} entries, ${rec.ticks} ticks)`);
console.log(digest === rec.digest ? 'replay     the same picture: the record is true' : `replay     DIFFERENT: the record says ${rec.digest}, the cartridge gives ${digest}`);
if (!rec.complete) console.log('note       the log was cut at its size limit; later inputs are missing');
process.exit(digest === rec.digest ? 0 : 1);
