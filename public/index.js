// Lists the games the server can run, then creates a match id and opens it as player 1.
// Games for more than two players also ask how many will play.
const select = document.getElementById("game");
const seats = document.getElementById("seats");
let games = [];

function showSeats() {
  const g = games.find(({ id }) => id === select.value);
  const max = g?.players ?? 2, min = g?.minPlayers ?? max;
  seats.replaceChildren(...Array.from({ length: max - min + 1 }, (_, i) => new Option(`${max - i} players`, max - i)));
  document.getElementById("seats-row").hidden = min === max;
}
select.addEventListener("change", showSeats);

fetch("/api/games")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
  .then((list) => {
    games = list;
    select.replaceChildren(...games.map(({ id, title }) => new Option(title, id)));
    showSeats();
  })
  .catch(() => { /* keep the built-in list in the page */ });

document.getElementById("start").addEventListener("submit", (e) => {
  e.preventDefault();
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const match = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
  const form = new FormData(e.target), game = form.get("game");
  const q = new URLSearchParams({ match, player: "1", game });
  if (!document.getElementById("seats-row").hidden) q.set("seats", form.get("seats"));
  location.href = `/play.html?${q}`;
});
