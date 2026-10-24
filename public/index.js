// Lists the games the server can run, then creates a match id and opens it as player 1.
// Games for more than two players also ask how many will play, and games that allow it
// how many round wins win the match.
const select = document.getElementById("game");
const seats = document.getElementById("seats");
const best = document.getElementById("best");
let games = [];

function showSeats() {
  const g = games.find(({ id }) => id === select.value);
  const max = g?.players ?? 2, min = g?.minPlayers ?? max;
  seats.replaceChildren(...Array.from({ length: max - min + 1 }, (_, i) => new Option(`${max - i} players`, max - i)));
  document.getElementById("seats-row").hidden = min === max;
  const choices = g?.bestChoices ?? [];
  best.replaceChildren(...choices.map((n) => new Option(n === 1 ? "1 round" : `${n} rounds`, n)));
  if (choices.includes(g.best)) best.value = g.best;
  document.getElementById("best-row").hidden = choices.length === 0;
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
  if (!document.getElementById("best-row").hidden) q.set("best", form.get("best"));
  location.href = `/play.html?${q}`;
});
