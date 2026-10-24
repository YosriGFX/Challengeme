// Lists the games the server can run, then creates a match id and opens it as player 1.
const select = document.getElementById("game");

fetch("/api/games")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
  .then((games) => {
    select.replaceChildren(...games.map(({ id, title }) => new Option(title, id)));
  })
  .catch(() => { /* keep the built-in list in the page */ });

document.getElementById("start").addEventListener("submit", (e) => {
  e.preventDefault();
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const match = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
  const game = new FormData(e.target).get("game");
  location.href = `/play.html?${new URLSearchParams({ match, player: "1", game })}`;
});
