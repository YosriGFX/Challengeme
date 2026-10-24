// Plays Coin Duel for a whole-match test: python3 tools/build.py template --bot template/bot.mjs --frames 20000
// Called before every frame. ram(player, label) reads that player's Game Boy (labels from
// build/game.sym), press(player, buttons) holds buttons: 01 right, 02 left, 04 up, 08 down,
// 10 A, 20 B, 40 select, 80 start. Player 1 plays a little better than player 2.
const SKILL = [0.9, 0.6];
let seed = 1;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;

export default function bot({ frame, ram, press }) {
  if (frame < 40) return;                                  // the start script does the handshake
  for (const p of [1, 2]) {
    if (ram(p, "wWait")) {                                 // between rounds: tap START now and then
      press(p, frame % 60 < 3 ? 0x80 : 0);
      continue;
    }
    const x = ram(p, `wP${p}X`), y = ram(p, `wP${p}Y`);
    const cx = ram(p, "wCoinX"), cy = ram(p, "wCoinY");
    if (random() > SKILL[p - 1]) { press(p, [0x01, 0x02, 0x04, 0x08][Math.floor(random() * 4)]); continue; }
    press(p, (cx > x + 1 ? 0x01 : cx < x - 1 ? 0x02 : 0) | (cy > y + 1 ? 0x08 : cy < y - 1 ? 0x04 : 0));
  }
}
