import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { handler as combined } from "../../../src/index.js";
import { notion, page, request, setupMockNotion, testPageId } from "../../../test-support/api.js";

const require = createRequire(import.meta.url);
const game = require("../functions/api.cjs").handler;
const gameDatabase = "1f41efa65d6e47eebe88b6313a2f9889";
const gameKey = "test-game-key";
const gamePage = page(gameDatabase, {
    title: { title: [{ plain_text: "Rayman" }] },
    status: { type: "multi_select", multi_select: [{ name: "queued" }] },
});

process.env.NOTION_GAMELIST_TOKEN = "test-game-token";
process.env.GAMELIST_WRITE_KEY = gameKey;
setupMockNotion();

test("combined API routes game requests and rejects neighboring prefixes", async () => {
    assert.equal((await request(combined, "/api/hello")).status, 200);
    notion().post(`/v1/databases/${gameDatabase}/query`)
        .reply(200, { results: [gamePage], next_cursor: null });
    assert.equal((await request(combined, "/api/gamelist/search?name=Rayman")).body[0].name, "Rayman");
    assert.equal((await request(combined, "/api/recipes-other")).status, 404);
    assert.equal((await request(combined, "/api/ll-other")).status, 404);
});

test("game handler exposes health and rejects routes owned by other apps", async () => {
    assert.equal((await request(game, "/api/hello")).status, 200);
    for (const path of ["/api/ll/all", "/api/recipes"]) {
        assert.equal((await request(game, path)).status, 404);
    }
});

test("game API returns 503 when its Notion token is missing", async () => {
    const savedToken = process.env.NOTION_GAMELIST_TOKEN;
    delete process.env.NOTION_GAMELIST_TOKEN;
    try {
        assert.equal((await request(game, "/api/gamelist")).status, 503);
    } finally {
        if (savedToken === undefined) delete process.env.NOTION_GAMELIST_TOKEN;
        else process.env.NOTION_GAMELIST_TOKEN = savedToken;
    }
});

test("game search and read retain their response shape", async () => {
    notion().post(`/v1/databases/${gameDatabase}/query`, (body) => body.filter.title.contains === "Rayman")
        .reply(200, { results: [gamePage], next_cursor: null });
    const result = await request(game, "/api/gamelist/search?name=Rayman");
    assert.equal(result.status, 200);
    assert.equal(result.body[0].name, "Rayman");
    assert.deepEqual(result.body[0].status, ["queued"]);

    notion().get(`/v1/pages/${testPageId}`).reply(200, gamePage);
    assert.equal((await request(game, `/api/gamelist/game/${testPageId}`)).body.name, "Rayman");
});

test("game writes require authentication and support create, edit, and delete", async () => {
    assert.equal((await request(game, "/api/gamelist", "POST", {})).status, 401);
    notion().get(`/v1/databases/${gameDatabase}`).reply(200, { properties: { status: { type: "multi_select" } } });
    notion().post("/v1/pages", (body) => body.parent.database_id === gameDatabase).reply(200, gamePage);
    assert.equal((await request(game, "/api/gamelist", "POST", {
        name: "Rayman", coverUrl: "https://example.com/cover.jpg", platform: "PC", status: ["queued"],
    }, gameKey)).status, 201);

    notion().get(`/v1/pages/${testPageId}`).twice().reply(200, gamePage);
    notion().patch(`/v1/pages/${testPageId}`, (body) => body.properties.completed.checkbox === true).reply(200, gamePage);
    assert.equal((await request(game, `/api/gamelist/game/${testPageId}`, "PATCH", { completed: true }, gameKey)).status, 200);

    notion().patch(`/v1/pages/${testPageId}`, { in_trash: true }).reply(200, { id: testPageId });
    assert.equal((await request(game, `/api/gamelist/game/${testPageId}`, "DELETE", undefined, gameKey)).body.deleted, true);
});