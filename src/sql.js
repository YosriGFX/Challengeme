// Every SQL statement of the Match Durable Object.
export const SQL = Object.freeze({
  createSeats: "CREATE TABLE IF NOT EXISTS seats (player INTEGER PRIMARY KEY, token_hash TEXT NOT NULL) STRICT",
  createMeta: "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT",
  seatHash: "SELECT token_hash FROM seats WHERE player = ?",
  claimSeat: "INSERT INTO seats (player, token_hash) VALUES (?, ?)",
  getGame: "SELECT v FROM meta WHERE k = 'game'",
  setGame: "INSERT OR IGNORE INTO meta (k, v) VALUES ('game', ?)",
  createResults: "CREATE TABLE IF NOT EXISTS results (round INTEGER PRIMARY KEY, winner INTEGER NOT NULL, " +
    "wins1 INTEGER NOT NULL, wins2 INTEGER NOT NULL, over INTEGER NOT NULL, at INTEGER NOT NULL, " +
    "reason TEXT NOT NULL DEFAULT 'game') STRICT",
  addResult: "INSERT INTO results (winner, wins1, wins2, over, at, reason) VALUES (?, ?, ?, ?, ?, ?)",
});
