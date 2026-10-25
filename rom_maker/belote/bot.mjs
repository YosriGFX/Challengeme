// Plays Belote for a whole-match test: python3 tools/build.py belote --bot belote/bot.mjs --frames 200000 --shots ""
// Every player bids now and then (and passes more often), contre and capot sometimes,
// and plays a random card it may play (the rules are copied here in legalSlots). A
// press is held 3 frames and let go 3, so the adapter's packets see it. setChooser(fn)
// lets a test pick the card instead: fn(player, slots, legal) returns a slot.
// Buttons: 01 right, 02 left, 04 up, 08 down, 10 A, 20 B, 40 select, 80 start.
const ST = { BID: 2, CONTRE: 3, PLAY: 4, WAIT: 7 }, CAPOT = 17, NO_CARD = 0xff;
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;
let choose = (p, slots, legal) => legal[Math.floor(random() * legal.length)];
const plan = {};                     // per player (0-3): { bits: [...] } presses still to make
const busy = [0, 0, 0, 0];           // frame each player may press again

// How often, per look, a player calls capot, contre or surcontre, and passes on their turn.
export const odds = { capot: 0.0004, contre: 0.004, surcontre: 0.01, pass: 0.55 };

export function seedBot(n) { seed = n >>> 0 || 1; }
export function setChooser(fn) { choose = fn; }
export { random };

const PLAIN = [0, 1, 2, 6, 3, 4, 5, 7], TRUMP = [0, 1, 6, 4, 7, 2, 3, 5];
const suit = (c) => c >> 3, rank = (c) => c & 7;

// The state of player p's Game Boy that the rules need.
export function view(ram, gb = 1) {
  const r = (name, i = 0) => ram(gb, name, i);
  const hands = [0, 1, 2, 3].map((p) => Array.from({ length: r("wCount", p) }, (_, i) => r("wHands", p * 8 + i)));
  return { state: r("wState"), turn: r("wTurn"), leader: r("wLeader"), played: r("wPlayed"), trump: r("wTrump"),
           bid: r("wBid"), bidder: r("wBidder"), coinche: r("wCoinche"), dealer: r("wDealer"), hands,
           table: [0, 1, 2, 3].map((p) => r("wTable", p)), cur: [0, 1, 2, 3].map((p) => r("wCur", p)),
           selV: [0, 1, 2, 3].map((p) => r("wSelV", p)), selS: [0, 1, 2, 3].map((p) => r("wSelS", p)) };
}

// Who takes the cards on the table so far.
export function trickWinner(table, leader, played, trump) {
  const led = suit(table[leader]);
  let best = -1, who = leader;
  for (let k = 0; k < played; k++) {
    const p = (leader + k) & 3, c = table[p];
    const key = suit(c) === trump ? 16 + TRUMP[rank(c)] : suit(c) === led ? 8 + PLAIN[rank(c)] : 0;
    if (key > best) { best = key; who = p; }
  }
  return who;
}

// The slots of player p's hand that may be played.
export function legalSlots({ hands, table, leader, played, trump }, p) {
  const hand = hands[p], all = hand.map((_, i) => i);
  if (!played) return all;
  const led = suit(table[leader]);
  const tableTrumps = table.filter((c) => c !== NO_CARD && suit(c) === trump).map((c) => TRUMP[rank(c)]);
  const best = tableTrumps.length ? Math.max(...tableTrumps) : -1;
  const ofLed = all.filter((i) => suit(hand[i]) === led);
  const trumps = all.filter((i) => suit(hand[i]) === trump);
  const higher = trumps.filter((i) => TRUMP[rank(hand[i])] > best);
  if (led === trump) return trumps.length ? (higher.length ? higher : trumps) : all;
  if (ofLed.length) return ofLed;
  if ((trickWinner(table, leader, played, trump) & 1) === (p & 1)) return all;
  if (!trumps.length) return all;
  return higher.length ? higher : trumps;
}

// The presses that move player p's picker to value v and suit s, then bid.
function bidPresses(v0, s0, v, s) {
  const bits = [];
  for (let x = v0; x < v; x++) bits.push(0x04);
  for (let x = v0; x > v; x--) bits.push(0x08);
  for (let x = s0; x !== s; x = (x + 1) & 3) bits.push(0x01);
  return [...bits, 0x10];
}

export default function bot({ frame, ram, press }) {
  if (frame < 40) return;
  for (let p = 0; p < 4; p++) {
    const gb = p + 1;
    if (frame < busy[p]) { if (frame === busy[p] - 3) press(gb, 0); continue; }
    const v = view(ram, gb);
    let bits = 0;
    if (plan[p]?.length && plan[p].state === v.state) bits = plan[p].shift();
    else {
      plan[p] = null;
      if (v.state === ST.WAIT) bits = frame % 50 === p ? 0x80 : 0;
      else if (v.state === ST.BID || v.state === ST.CONTRE) bits = bidChoice(v, p);
      else if (v.state === ST.PLAY && v.turn === p) bits = playChoice(v, p);
    }
    if (!bits) continue;
    press(gb, bits);
    busy[p] = frame + 6;
  }
}

function bidChoice(v, p) {
  if (random() < odds.capot) return 0x80;                               // capot, any time
  const opponent = v.bid && v.bidder !== 0xff && ((v.bidder ^ p) & 1) === 1;
  if (v.state === ST.BID && opponent && v.bid < CAPOT && !v.coinche && random() < odds.contre) return 0x40;
  if (v.state === ST.CONTRE) return !opponent && random() < odds.surcontre ? 0x40 : 0;
  if (v.turn !== p || random() < 0.9) return 0;                         // take a moment
  // the suit this hand is best in as trump: trump points, and 10 a card
  const strength = [0, 1, 2, 3].map((s) => v.hands[p].filter((c) => suit(c) === s)
    .reduce((sum, c) => sum + 10 + [0, 0, 14, 10, 20, 3, 4, 11][rank(c)], 0));
  const best = strength.indexOf(Math.max(...strength));
  const top = Math.max(9, v.bid + 1);
  const worth = 7 + Math.floor(strength[best] / 12);                    // what the hand might make, in tens
  if (top > 16 || top > worth + 1 || random() < odds.pass) return 0x20;  // pass
  const value = top + Math.floor(random() * Math.min(2, 17 - top));
  plan[p] = bidPresses(v.selV[p], v.selS[p], value, best);
  plan[p].state = v.state;
  return plan[p].shift();
}

function playChoice(v, p) {
  if (random() < 0.8) return 0;
  const slot = choose(p, v.hands[p].map((_, i) => i), legalSlots(v, p));
  const cur = v.cur[p];
  if (cur !== slot) return cur < slot ? 0x01 : 0x02;
  return 0x10;
}
