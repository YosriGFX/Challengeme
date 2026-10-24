// Worker: serves the match WebSocket and the list of games. Pages and scripts are static
// assets from ./public. The games themselves run in the Match Durable Object (src/match.js).
import { GAMES } from "./games/index.js";

export { Match } from "./match.js";

const GAME_LIST = Object.entries(GAMES).map(([id, { title }]) => ({ id, title }));

const MATCH_ID = /^[a-z0-9]{6,16}$/;
const GAME_ID = /^[a-z0-9_-]{1,32}$/;

const json = (data, status) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, scope, resource, id] = url.pathname.split("/");        // /ws/match/<id>?player=1|2[&game=<name>]
    try {
      switch (`${request.method} ${scope} ${resource}`) {
        case "GET api games":
          return Response.json(GAME_LIST, { headers: { "Cache-Control": "public, max-age=60" } });
        case "GET ws match": {
          if (!MATCH_ID.test(id ?? "")) return json({ error: "bad_match_id" }, 400);
          if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
          if (!allowedOrigin(request.headers.get("Origin"), env.APP_ORIGIN)) {
            console.log(JSON.stringify({ msg: "bad_origin", origin: request.headers.get("Origin") }));
            return json({ error: "bad_origin" }, 403);
          }
          const player = url.searchParams.get("player");
          if (player !== "1" && player !== "2") return json({ error: "bad_player" }, 400);
          const game = url.searchParams.get("game") ?? "";
          if (game !== "" && !GAME_ID.test(game)) return json({ error: "bad_game" }, 400);
          const req = new Request(request, { headers: new Headers(request.headers) });
          req.headers.set("X-Player", player);
          req.headers.set("X-Game", game);
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

// APP_ORIGIN is one origin or a comma-separated list.
function allowedOrigin(origin, allowed) {
  return origin !== null && (allowed ?? "").split(",").some((o) => o.trim() === origin);
}
