// Worker: serves nothing but the match WebSocket. Pages, scripts and the translated
// games (.wasm) are static assets from ./public and never reach this code.
export { Match } from "./match.js";

const MATCH_ID = /^[a-z0-9]{6,16}$/;

const json = (data, status) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, scope, resource, id] = url.pathname.split("/");        // /ws/match/<id>
    try {
      switch (`${request.method} ${scope} ${resource}`) {
        case "GET ws match": {
          if (!MATCH_ID.test(id ?? "")) return json({ error: "bad_match_id" }, 400);
          if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
          if (!allowedOrigin(request.headers.get("Origin"), env.APP_ORIGIN)) {
            console.log(JSON.stringify({ msg: "bad_origin", origin: request.headers.get("Origin") }));
            return json({ error: "bad_origin" }, 403);
          }
          const role = url.searchParams.get("role");
          const player = url.searchParams.get("player");
          let seat;
          if (role === "host") seat = "host";
          else if (role === "pad" && (player === "1" || player === "2")) seat = `pad:${player}`;
          else return json({ error: "bad_role" }, 400);
          const req = new Request(request, { headers: new Headers(request.headers) });
          req.headers.set("X-Seat", seat);
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
