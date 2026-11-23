import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { handler as combined } from "../../../src/index.js";
import { notion, page, request, setupMockNotion, testPageId } from "../../../test-support/api.js";

const require = createRequire(import.meta.url);
const cooking = require("../functions/api.cjs").handler;
const recipeDatabase = "123456781234123412341234567890ab";
const recipeKey = "test-recipe-key";
const recipe = page(recipeDatabase, {
    title: { title: [{ plain_text: "Pasta" }] },
    ingredients: { rich_text: [{ plain_text: "Pasta\nTomatoes" }] },
    category: { multi_select: [{ name: "Dinner" }] },
    servings: { number: 2 },
});

process.env.NOTION_COOKING_COMPENDIUM_TOKEN = "test-recipe-token";
process.env.NOTION_COOKING_COMPENDIUM_DATABASE_ID = recipeDatabase;
process.env.COOKING_COMPENDIUM_WRITE_KEY = recipeKey;
setupMockNotion();

test("combined API routes recipe listing and search", async () => {
    for (const path of ["/api/recipes", "/api/recipes/search?name=Pasta"]) {
        notion().post(`/v1/databases/${recipeDatabase}/query`)
            .reply(200, { results: [recipe], next_cursor: null });
        assert.equal((await request(combined, path)).body[0].name, "Pasta");
    }
});

test("recipe handler exposes health and rejects routes owned by other apps", async () => {
    assert.equal((await request(cooking, "/api/hello")).status, 200);
    for (const path of ["/api/gamelist", "/api/ll/all"]) {
        assert.equal((await request(cooking, path)).status, 404);
    }
});

test("recipe API returns 503 when configuration is missing", async () => {
    for (const variable of [
        "NOTION_COOKING_COMPENDIUM_TOKEN",
        "NOTION_COOKING_COMPENDIUM_DATABASE_ID",
    ]) {
        const savedValue = process.env[variable];
        delete process.env[variable];
        try {
            assert.equal((await request(cooking, "/api/recipes")).status, 503);
        } finally {
            if (savedValue === undefined) delete process.env[variable];
            else process.env[variable] = savedValue;
        }
    }
});

test("recipe listing paginates and maps Notion properties", async () => {
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) => !body.start_cursor)
        .reply(200, { results: [recipe], next_cursor: testPageId });
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) => body.start_cursor === testPageId)
        .reply(200, { results: [], next_cursor: null });
    const response = await request(cooking, "/api/recipes");
    assert.equal(response.status, 200);
    assert.equal(response.body[0].name, "Pasta");
    assert.equal(response.body[0].ingredients, "Pasta\nTomatoes");
    assert.deepEqual(response.body[0].category, ["Dinner"]);
    assert.equal(response.body[0].servings, 2);
});

test("recipe search validates its query and options use the configured database", async () => {
    assert.equal((await request(cooking, "/api/recipes/search")).status, 400);
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) => body.filter.title.contains === "Pasta")
        .reply(200, { results: [recipe], next_cursor: null });
    assert.equal((await request(cooking, "/api/recipes/search?name=Pasta")).body.length, 1);

    notion().get(`/v1/databases/${recipeDatabase}`).reply(200, {
        properties: { category: { multi_select: { options: [{ name: "Dinner" }] } } },
    });
    assert.deepEqual((await request(cooking, "/api/recipes/options")).body.category, ["Dinner"]);
});

test("recipe writes require the private API key", async () => {
    for (const [method, path] of [["POST", "/api/recipes"], ["PATCH", `/api/recipes/${testPageId}`], ["DELETE", `/api/recipes/${testPageId}`]]) {
        assert.equal((await request(cooking, path, method, {})).status, 401);
        assert.equal((await request(cooking, path, method, {}, "wrong-key")).status, 401);
    }
});

test("recipe creation validates input and chunks long ingredients for Notion", async () => {
    for (const body of [{}, { name: "" }, { name: "Pasta", unknown: true },
        { name: "Pasta", cookTime: -1 }, { name: "Pasta", category: ["Dinner", " Dinner "] },
        { name: "Pasta", coverUrl: "javascript:alert(1)" }]) {
        assert.equal((await request(cooking, "/api/recipes", "POST", body, recipeKey)).status, 400);
    }
    notion().post("/v1/pages", (body) => body.parent.database_id === recipeDatabase &&
        body.properties.ingredients.rich_text.length === 2 &&
        body.properties.ingredients.rich_text[0].text.content.length === 2000).reply(200, recipe);
    const result = await request(cooking, "/api/recipes", "POST", {
        name: "Pasta", ingredients: "x".repeat(2001), category: ["Dinner"], servings: 2,
    }, recipeKey);
    assert.equal(result.status, 201);
    assert.equal(result.body.name, "Pasta");
});

test("recipes can be read, patched, cleared, and deleted", async () => {
    notion().get(`/v1/pages/${testPageId}`).times(3).reply(200, recipe);
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`)).body.name, "Pasta");

    notion().patch(`/v1/pages/${testPageId}`, {
        properties: {
            description: { rich_text: [] }, category: { multi_select: [] },
            servings: { number: null }, cover: { files: [] },
        },
    }).reply(200, recipe);
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`, "PATCH", {
        description: "", category: [], servings: null, coverUrl: "",
    }, recipeKey)).status, 200);

    notion().patch(`/v1/pages/${testPageId}`, { in_trash: true }).reply(200, { id: testPageId });
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`, "DELETE", undefined, recipeKey)).body.deleted, true);
});

test("recipe reads and writes reject foreign or archived pages", async () => {
    for (const invalidPage of [page("1f41efa65d6e47eebe88b6313a2f9889"), { ...recipe, archived: true }, { ...recipe, in_trash: true }]) {
        for (const method of ["GET", "PATCH", "DELETE"]) {
            notion().get(`/v1/pages/${testPageId}`).reply(200, invalidPage);
            assert.equal((await request(cooking, `/api/recipes/${testPageId}`, method,
                method === "PATCH" ? { name: "Pasta" } : undefined, recipeKey)).status, 404);
        }
    }
});

test("malformed JSON and missing recipes return client errors", async () => {
    assert.equal((await request(cooking, "/api/recipes", "POST", "{", recipeKey)).status, 400);
    notion().get(`/v1/pages/${testPageId}`).reply(404, {
        object: "error", status: 404, code: "object_not_found", message: "Not found",
    });
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`)).status, 404);
});