var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/match.js
import { DurableObject } from "cloudflare:workers";
var MAX_PER_SECOND = 60;
var Match = class extends DurableObject {
  static {
    __name(this, "Match");
  }
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.rate = /* @__PURE__ */ new Map();
  }
  async fetch(request) {
    const seat = request.headers.get("X-Seat");
    if (seat !== "host" && seat !== "pad:1" && seat !== "pad:2") return new Response(null, { status: 400 });
    for (const old of this.ctx.getWebSockets(seat)) old.close(4e3, "replaced");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [seat]);
    server.serializeAttachment({ seat });
    if (seat === "host") {
      server.send(JSON.stringify({ t: "pads", on: this.padsOnline() }));
    } else {
      this.toHost(JSON.stringify({ t: "pad", player: Number(seat[4]), on: true }));
    }
    console.log(JSON.stringify({ msg: "join", seat }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const { seat } = ws.deserializeAttachment();
    if (seat === "host") return;
    if (typeof message === "string" || message.byteLength !== 1) return ws.close(1003, "one byte expected");
    if (!this.allow(ws)) return;
    this.toHost(new Uint8Array([Number(seat[4]), new Uint8Array(message)[0]]));
  }
  async webSocketClose(ws) {
    this.rate.delete(ws);
    const { seat } = ws.deserializeAttachment() ?? {};
    if (seat?.startsWith("pad:")) {
      const on = this.ctx.getWebSockets(seat).some((s) => s !== ws);
      this.toHost(JSON.stringify({ t: "pad", player: Number(seat[4]), on }));
    }
  }
  async webSocketError(ws, error) {
    console.error(JSON.stringify({ msg: "ws_error", error: String(error) }));
  }
  padsOnline() {
    return [1, 2].filter((n) => this.ctx.getWebSockets(`pad:${n}`).length > 0);
  }
  toHost(data) {
    for (const ws of this.ctx.getWebSockets("host")) {
      try {
        ws.send(data);
      } catch {
      }
    }
  }
  // Token bucket per socket: MAX_PER_SECOND messages, refilled continuously.
  allow(ws) {
    const now = Date.now();
    const b = this.rate.get(ws) ?? { tokens: MAX_PER_SECOND, at: now };
    b.tokens = Math.min(MAX_PER_SECOND, b.tokens + (now - b.at) * MAX_PER_SECOND / 1e3);
    b.at = now;
    this.rate.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
};

// src/index.js
var MATCH_ID = /^[a-z0-9]{6,16}$/;
var json = /* @__PURE__ */ __name((data, status) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } }), "json");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, scope, resource, id] = url.pathname.split("/");
    try {
      switch (`${request.method} ${scope} ${resource}`) {
        case "GET ws match": {
          if (!MATCH_ID.test(id ?? "")) return json({ error: "bad_match_id" }, 400);
          if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
          if (request.headers.get("Origin") !== env.APP_ORIGIN) return json({ error: "bad_origin" }, 403);
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
  }
};

// ../../../tmp/claude-0/-home-claude-challengeme/55b37a54-fe14-50e2-a4d0-1b83507b85bc/scratchpad/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../tmp/claude-0/-home-claude-challengeme/55b37a54-fe14-50e2-a4d0-1b83507b85bc/scratchpad/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-GXZCp9/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../tmp/claude-0/-home-claude-challengeme/55b37a54-fe14-50e2-a4d0-1b83507b85bc/scratchpad/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-GXZCp9/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Match,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
