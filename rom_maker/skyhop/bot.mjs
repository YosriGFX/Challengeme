// Plays Sky Hop for a whole-match test: python3 tools/build.py skyhop --bot skyhop/bot.mjs --frames 30000
// Called before every frame. ram(player, label) reads that player's Game Boy (labels from
// build/game.sym), press(player, buttons) holds buttons: 01 right, 02 left, 04 up, 08 down,
// 10 A, 20 B, 40 select, 80 start. Each bot steers under the platform it can reach next;
// lower players are worse at it, so rounds have different winners.
const SKILL = [0.9, 0.8, 0.7, 0.6];
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;

export default function bot({ frame, ram, press, players }) {
  if (frame < 40) return;                                  // the start script starts the link
  for (let p = 1; p <= players; p++) {
    const state = ram(p, "wState");
    if (state === 2) {                                     // between rounds: tap START now and then
      press(p, (frame + p * 7) % 40 < 3 ? 0x80 : 0);
      continue;
    }
    if (state !== 1) continue;
    const i = p - 1;                                       // arrays are player 1 first
    const h = ram(p, "wPHl", i) | (ram(p, "wPHh", i) << 8);
    const x = ram(p, "wPX", i), rising = ram(p, "wPVh", i) < 0x80;
    const row = rising ? (h + 48) >> 5 : h >> 5;               // the row it can land on next
    const column = ram(p, "wRows", row & 15);
    const target = column === 0xff ? x + 4 : column * 8 + 16;
    if (random() > SKILL[i]) { press(p, random() < 0.5 ? 0x01 : 0x02); continue; }
    press(p, x + 4 < target - 2 ? 0x01 : x + 4 > target + 2 ? 0x02 : 0);
  }
}
