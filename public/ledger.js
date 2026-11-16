// ledger.js — sign the result of a finished match with the player's own wallet.
//
// For games that hide nothing, the server gives the record of a match: the hash of the
// cartridge, the hash of the log, and who won. evm/MatchLedger.sol keeps such a result on
// an EVM chain once both players have signed it. This file does the signing: it asks the
// contract for the 32 bytes that stand for the result, has the wallet sign them, and hands
// the signature to the match, next to the other player's.
//
// It needs a wallet in the browser (window.ethereum) and a deployed ledger whose address
// the server knows. Nothing here can move money: personal_sign signs a message, nothing else.

const BODY = '0x09fc8c35';                           // body(bytes32,bytes32,bytes32,uint8), first 4 bytes of its keccak-256

export const hasWallet = () => typeof window.ethereum?.request === 'function';

// Returns a short line for the player: what happened.
export async function signResult(cart, room) {
  const eth = window.ethereum;
  if (!hasWallet()) return 'NO WALLET HERE';
  let rec;
  try { const r = await fetch(`/api/log/${cart}/${room}`); if (!r.ok) return 'NO RECORD'; rec = await r.json(); } catch { return 'NO CONNECTION'; }
  if (!rec.ledger || !rec.id) return 'NO LEDGER YET';
  if (rec.result === 255) return 'NOT OVER YET';
  try {
    const [account] = await eth.request({ method: 'eth_requestAccounts' });
    if (parseInt(await eth.request({ method: 'eth_chainId' }), 16) !== rec.ledger.chain) return 'WRONG NETWORK';
    const word = (h) => h.slice(2).padStart(64, '0');
    const data = BODY + word(rec.id) + word(rec.cart_sha256) + word(rec.log_sha256) + word('0x' + rec.result.toString(16));
    const body = await eth.request({ method: 'eth_call', params: [{ to: rec.ledger.address, data }, 'latest'] });
    if (!/^0x[0-9a-fA-F]{64}$/.test(body)) return 'LEDGER DID NOT ANSWER';
    const signature = await eth.request({ method: 'personal_sign', params: [body, account] });
    const r = await fetch(`/api/sign/${cart}/${room}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: account, signature }) });
    if (!r.ok) return 'NOT ACCEPTED';
    return (await r.json()).signed >= 2 ? 'BOTH SIGNED' : 'SIGNED';
  } catch { return 'NOT SIGNED'; }             // the player said no in the wallet, or the wallet failed
}
