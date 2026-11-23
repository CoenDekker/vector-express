import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { handler as combined } from "../../../src/index.js";
import { notion, page, request, setupMockNotion, testPageId } from "../../../test-support/api.js";

const require = createRequire(import.meta.url);
const legends = require("../functions/api.cjs").handler;
const llDatabase = "1166b583229a80f4a431e9b43908ff61";

process.env.NOTION_LL_TOKEN = "test-ll-token";
setupMockNotion();

test("combined API routes Late Legends requests", async () => {
    notion().post(`/v1/databases/${llDatabase}/query`)
        .reply(200, { results: [], next_cursor: null });
    assert.deepEqual((await request(combined, "/api/ll/all")).body, []);
});

test("Late Legends handler exposes health and rejects routes owned by other apps", async () => {
    assert.equal((await request(legends, "/api/hello")).status, 200);
    for (const path of ["/api/gamelist", "/api/recipes"]) {
        assert.equal((await request(legends, path)).status, 404);
    }
});

test("Late Legends API returns 503 when its Notion token is missing", async () => {
    const savedToken = process.env.NOTION_LL_TOKEN;
    delete process.env.NOTION_LL_TOKEN;
    try {
        assert.equal((await request(legends, "/api/ll/all")).status, 503);
    } finally {
        if (savedToken === undefined) delete process.env.NOTION_LL_TOKEN;
        else process.env.NOTION_LL_TOKEN = savedToken;
    }
});

test("Late Legends reads paginate and preserve user filtering", async () => {
    const build = page(llDatabase, { userid: { rich_text: [{ plain_text: "user-1" }] }, name: { title: [{ plain_text: "Mage" }] } });
    for (const field of ["core", "class", "skill", "job", "element", "equipment", "filter", "cooldown", "artifact", "trinket", "set", "item", "buff", "note", "setting"]) {
        build.properties[field] = { rich_text: [{ plain_text: "" }] };
    }
    for (const field of ["health", "shield", "race", "level"]) build.properties[field] = { number: 0 };

    notion().post(`/v1/databases/${llDatabase}/query`, (body) => !body.start_cursor)
        .reply(200, { results: [build], next_cursor: testPageId });
    notion().post(`/v1/databases/${llDatabase}/query`, (body) => body.start_cursor === testPageId)
        .reply(200, { results: [], next_cursor: null });
    const response = await request(legends, "/api/ll/user-1");
    assert.equal(response.status, 200);
    assert.equal(response.body[0].name, "Mage");
});

test("Late Legends accepts JSON and legacy text bodies for add", async () => {
    for (const contentType of ["application/json", "text/plain"]) {
        notion().post(`/v1/databases/${llDatabase}/query`).reply(200, { results: [], next_cursor: null });
        notion().post("/v1/pages", (body) => body.properties.name.title[0].text.content === "Mage")
            .reply(200, { id: testPageId });
        assert.equal((await request(legends, "/api/ll/add/", "POST",
            JSON.stringify({ userid: "user-1", name: "Mage" }), undefined, contentType)).status, 200);
    }
});