import { handler as gamelist } from "../apps/gamelist-express/src/api.js";
import { handler as latelegends } from "../apps/latelegends-express/src/api.js";
import { handler as cooking } from "../apps/cooking-compendium-express/src/api.js";

export const handler = (event, context) => {
    const path = event.path || event.rawPath || "/";
    if (path === "/api/ll" || path.startsWith("/api/ll/")) {
        return latelegends(event, context);
    }
    if (path === "/api/recipes" || path.startsWith("/api/recipes/")) {
        return cooking(event, context);
    }
    return gamelist(event, context);
};
