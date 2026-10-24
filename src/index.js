// Worker: serves the match WebSocket and the list of games. Pages and scripts are static
// assets from ./public. The games themselves run in the Match Durable Object (src/match.js).
import { GAMES, TIME_CHOICES } from "./games/index.js";

export { Match } from "./match.js";

const GAME_LIST = Object.entries(GAMES).map(([id, { title, players, minPlayers, result }]) =>
  ({ id, title, players, minPlayers, best: result?.best, bestChoices: result?.bestAt ? result.bestChoices : undefined,
     times: result ? TIME_CHOICES : undefined }));

const MATCH_ID = /^[a-z0-9]{6,16}$/;
const GAME_ID = /^[a-z0-9_-]{1,32}$/;

const json = (data, status) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, scope, resource, id] = url.pathname.split("/");        // /ws/match/<id>?player=1-4[&game=<name>[&seats=2-4][&best=1-99][&time=s]]
    try {
      switch (`${request.method} ${scope} ${resource}`) {
        case "GET api games":
          return Response.json(GAME_LIST, { headers: { "Cache-Control": "public, max-age=60" } });
        case "GET ws match": {
          if (!MATCH_ID.test(id ?? "")) return json({ error: "bad_match_id" }, 400);
          if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
          if (!allowedOrigin(request, env.APP_ORIGIN)) {
            console.log(JSON.stringify({ msg: "bad_origin", origin: request.headers.get("Origin"), host: request.headers.get("Host") }));
            return json({ error: "bad_origin" }, 403);
          }
          const player = url.searchParams.get("player");
          if (!/^[1-4]$/.test(player ?? "")) return json({ error: "bad_player" }, 400);
          const game = url.searchParams.get("game") ?? "", seats = url.searchParams.get("seats") ?? "";
          if (game !== "" && !GAME_ID.test(game)) return json({ error: "bad_game" }, 400);
          if (!/^[2-4]?$/.test(seats)) return json({ error: "bad_seats" }, 400);
          const best = url.searchParams.get("best") ?? "";
          if (!/^([1-9][0-9]?)?$/.test(best)) return json({ error: "bad_best" }, 400);
          const time = url.searchParams.get("time") ?? "";
          if (!/^[0-9]{0,4}$/.test(time)) return json({ error: "bad_time" }, 400);
          const req = new Request(request, { headers: new Headers(request.headers) });
          req.headers.set("X-Player", player);
          req.headers.set("X-Game", game);
          req.headers.set("X-Seats", seats);
          req.headers.set("X-Best", best);
          req.headers.set("X-Time", time);
          return env.MATCH.getByName(id).fetch(req);
        }
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, error: String(err?.stack ?? err) }));
      return json({ error: "internal_error" }, 500);
    }
  },
};

// A page may open a match socket when its origin is in APP_ORIGIN (one origin or a
// comma-separated list), or when it was served by this host, whatever the scheme: behind
// a TLS proxy (nginx, wrangler dev --local-protocol https) the page is https while the
// Worker sees http. Browsers set Origin and Host themselves, so another site's page
// cannot pass this check.
function allowedOrigin(request, allowed) {
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  if ((allowed ?? "").split(",").some((o) => o.trim() === origin)) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return [request.headers.get("Host"), request.headers.get("X-Forwarded-Host")].includes(host);
}
