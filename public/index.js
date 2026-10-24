// Creates a match id and opens it as player 1.
document.getElementById("start").addEventListener("submit", (e) => {
  e.preventDefault();
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const match = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
  const game = new FormData(e.target).get("game");
  location.href = `/play.html?${new URLSearchParams({ match, player: "1", game })}`;
});
