// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The result of a turn-based match, signed by both players, kept where neither of them
/// (and no server) can change it afterwards.
///
/// A cartridge is deterministic. A match is therefore fully described by two hashes:
///   cart  SHA-256 of the cartridge's .wasm
///   log   SHA-256 of the match log (every input and the tick it was made on)
/// `node host/replay.mjs match.json` prints both and checks that the log really ends in
/// the result. The contract does not run the game: it records what both players signed,
/// and anybody can check it off the chain with the cartridge and the log.
contract MatchLedger {
    struct Result { address p1; address p2; bytes32 cart; bytes32 log; uint8 winner; uint64 at; }

    mapping(bytes32 => Result) public results;                     // match id => result
    event Settled(bytes32 indexed id, address indexed p1, address indexed p2, bytes32 cart, bytes32 log, uint8 winner);

    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// What a result is, as 32 bytes: this chain, this contract, the match, the cartridge,
    /// the log and the winner (0 = player 1, 1 = player 2, 2 = draw). A wallet signs these
    /// bytes with personal_sign (the client asks for them with eth_call, see public/ledger.js).
    function body(bytes32 id, bytes32 cart, bytes32 log, uint8 winner) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, cart, log, winner));
    }

    /// The same as an Ethereum signed message: what the two signatures are checked against.
    function digest(bytes32 id, bytes32 cart, bytes32 log, uint8 winner) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", body(id, cart, log, winner)));
    }

    /// Record a result. Anyone may send it; it counts only with both players' signatures.
    function settle(bytes32 id, address p1, address p2, bytes32 cart, bytes32 log, uint8 winner, bytes calldata sig1, bytes calldata sig2) external {
        require(results[id].at == 0, "already settled");
        require(winner <= 2, "winner is 0, 1 or 2");
        require(p1 != address(0) && p2 != address(0) && p1 != p2, "two different players");
        bytes32 d = digest(id, cart, log, winner);
        require(signer(d, sig1) == p1 && signer(d, sig2) == p2, "both players must sign");
        results[id] = Result(p1, p2, cart, log, winner, uint64(block.timestamp));
        emit Settled(id, p1, p2, cart, log, winner);
    }

    function signer(bytes32 d, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "a signature is 65 bytes");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        require(uint256(s) <= HALF_ORDER, "signature not in low-s form");
        return ecrecover(d, v, r, s);
    }
}
