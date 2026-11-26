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
    name: { title: [{ plain_text: "Pasta" }] },
    author: { select: { name: "hers" } },
    verified: { checkbox: true },
    ingredients: { rich_text: [{ plain_text: "Pasta\nTomatoes" }] },
    preparation: { rich_text: [{ plain_text: "Boil pasta.\nSimmer sauce." }] },
    tags: { multi_select: [{ name: "Dinner" }] },
    photo: { files: [{ type: "file", file: { url: "https://notion.example/upload.jpg" } }] },
    link: { url: "https://example.com/pasta" },
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
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) =>
        !body.start_cursor && body.sorts[0].property === "name")
        .reply(200, { results: [recipe], next_cursor: testPageId });
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) => body.start_cursor === testPageId)
        .reply(200, { results: [], next_cursor: null });
    const response = await request(cooking, "/api/recipes");
    assert.equal(response.status, 200);
    assert.equal(response.body[0].name, "Pasta");
    assert.equal(response.body[0].ingredients, "Pasta\nTomatoes");
    assert.deepEqual(response.body[0], {
        id: testPageId, name: "Pasta", tags: ["Dinner"],
        author: "hers", verified: true, private: false,
        ingredients: "Pasta\nTomatoes", preparation: "Boil pasta.\nSimmer sauce.",
        photo: "https://notion.example/upload.jpg", link: "https://example.com/pasta",
    });
});

test("recipe search validates its query and options use the configured database", async () => {
    assert.equal((await request(cooking, "/api/recipes/search")).status, 400);
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) =>
        body.filter.property === "name" && body.filter.title.contains === "Pasta")
        .reply(200, { results: [recipe], next_cursor: null });
    assert.equal((await request(cooking, "/api/recipes/search?name=Pasta")).body.length, 1);

    notion().get(`/v1/databases/${recipeDatabase}`).reply(200, {
        properties: { tags: { multi_select: { options: [{ name: "Dinner" }] } } },
    });
    assert.deepEqual((await request(cooking, "/api/recipes/options")).body, { tags: ["Dinner"] });
});

test("private recipes require the server key on lists, searches, and direct reads", async () => {
    const privateRecipe = { ...recipe, properties: { ...recipe.properties, private: { checkbox: true } } };
    for (const key of [undefined, "wrong-key", recipeKey]) {
        for (const path of ["/api/recipes", "/api/recipes/search?name=Pasta"]) {
            notion().post(`/v1/databases/${recipeDatabase}/query`)
                .reply(200, { results: [recipe], next_cursor: testPageId });
            notion().post(`/v1/databases/${recipeDatabase}/query`)
                .reply(200, { results: [privateRecipe], next_cursor: null });
            const result = await request(combined, path, "GET", undefined, key);
            assert.equal(result.status, 200);
            assert.equal(result.body.length, key === recipeKey ? 2 : 1);
        }
        notion().get(`/v1/pages/${testPageId}`).reply(200, privateRecipe);
        const result = await request(cooking, `/api/recipes/${testPageId}`, "GET", undefined, key);
        assert.equal(result.status, key === recipeKey ? 200 : 404);
        if (key === recipeKey) assert.equal(result.body.private, true);
    }
});

test("private is a boolean Notion checkbox and can be cleared independently", async () => {
    for (const value of ["true", 1, null]) {
        assert.equal((await request(cooking, "/api/recipes", "POST", { name: "Soup", private: value }, recipeKey)).status, 400);
    }
    for (const value of [true, false]) {
        notion().get(`/v1/pages/${testPageId}`).reply(200, recipe);
        notion().patch(`/v1/pages/${testPageId}`, { properties: { private: { checkbox: value } } })
            .reply(200, { ...recipe, properties: { ...recipe.properties, private: { checkbox: value } } });
        const result = await request(cooking, `/api/recipes/${testPageId}`, "PATCH", { private: value }, recipeKey);
        assert.equal(result.status, 200);
        assert.equal(result.body.private, value);
    }
});

test("recipe reads default missing author and verified properties", async () => {
    notion().get(`/v1/pages/${testPageId}`).reply(200, page(recipeDatabase, {
        name: { title: [{ plain_text: "Soup" }] },
    }));
    const result = await request(cooking, `/api/recipes/${testPageId}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.author, "");
    assert.equal(result.body.verified, false);
});

test("recipe author and verified can be updated independently", async () => {
    for (const author of ["his", "hers"]) {
        notion().get(`/v1/pages/${testPageId}`).reply(200, recipe);
        notion().patch(`/v1/pages/${testPageId}`, {
            properties: { author: { select: { name: author } } },
        }).reply(200, { ...recipe, properties: { ...recipe.properties, author: { select: { name: author } } } });
        const result = await request(cooking, `/api/recipes/${testPageId}`, "PATCH", { author }, recipeKey);
        assert.equal(result.status, 200);
        assert.equal(result.body.author, author);
        assert.equal(result.body.verified, true);
    }
    for (const verified of [false, true]) {
        notion().get(`/v1/pages/${testPageId}`).reply(200, recipe);
        notion().patch(`/v1/pages/${testPageId}`, {
            properties: { verified: { checkbox: verified } },
        }).reply(200, { ...recipe, properties: { ...recipe.properties, verified: { checkbox: verified } } });
        const result = await request(cooking, `/api/recipes/${testPageId}`, "PATCH", { verified }, recipeKey);
        assert.equal(result.status, 200);
        assert.equal(result.body.verified, verified);
        assert.equal(result.body.author, "hers");
    }
});

test("recipe writes require the private API key", async () => {
    for (const [method, path] of [["POST", "/api/recipes"], ["PATCH", `/api/recipes/${testPageId}`], ["DELETE", `/api/recipes/${testPageId}`], ["DELETE", "/api/recipes/tags/Dinner"]]) {
        assert.equal((await request(cooking, path, method, {})).status, 401);
        assert.equal((await request(cooking, path, method, {}, "wrong-key")).status, 401);
    }
});

test("tag removal updates every page before removing the option and leaves recipes intact", async () => {
    const otherId = "abcdefab123412341234abcdefabcdef";
    const options = [{ id: "dinner", name: "Dinner", color: "green" }, { id: "easy", name: "Easy", color: "blue" }];
    notion().get(`/v1/databases/${recipeDatabase}`).times(2).reply(200, { properties: { tags: { multi_select: { options } } } });
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) => !body.start_cursor && body.filter.multi_select.contains === "Dinner")
        .reply(200, { results: [{ ...recipe, properties: { ...recipe.properties, tags: { multi_select: options } } }], next_cursor: otherId });
    notion().post(`/v1/databases/${recipeDatabase}/query`, (body) => body.start_cursor === otherId)
        .reply(200, { results: [{ ...recipe, id: otherId }], next_cursor: null });
    notion().patch(`/v1/pages/${testPageId}`, { properties: { tags: { multi_select: [{ id: "easy" }] } } }).reply(200, recipe);
    notion().patch(`/v1/pages/${otherId}`, { properties: { tags: { multi_select: [] } } }).reply(200, recipe);
    notion().patch(`/v1/databases/${recipeDatabase}`, { properties: { tags: { multi_select: { options: [options[1]] } } } }).reply(200, {});
    const result = await request(combined, "/api/recipes/tags/dinner", "DELETE", undefined, recipeKey);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { tag: "Dinner", deleted: true, updated: 2, tags: ["Easy"] });
});

test("tag removal validates names and stops without removing the option on a recipe failure", async () => {
    for (const tag of ["%20", "a".repeat(101)]) {
        assert.equal((await request(cooking, `/api/recipes/tags/${tag}`, "DELETE", undefined, recipeKey)).status, 400);
    }
    notion().get(`/v1/databases/${recipeDatabase}`).reply(200, { properties: { tags: { multi_select: { options: [] } } } });
    assert.equal((await request(cooking, "/api/recipes/tags/Missing", "DELETE", undefined, recipeKey)).status, 404);
    notion().get(`/v1/databases/${recipeDatabase}`).reply(200, { properties: { tags: { multi_select: { options: [{ name: "Dinner" }] } } } });
    notion().post(`/v1/databases/${recipeDatabase}/query`).reply(200, { results: [recipe], next_cursor: null });
    notion().patch(`/v1/pages/${testPageId}`).reply(400, { object: "error", status: 400, code: "validation_error", message: "Rejected" });
    const result = await request(cooking, "/api/recipes/tags/Dinner", "DELETE", undefined, recipeKey);
    assert.equal(result.status, 502);
    assert.equal(result.body.deleted, false);
    assert.equal(result.body.updated, 0);
    assert.match(result.body.error, /Retry/);
});

test("recipe creation validates input and chunks long ingredients for Notion", async () => {
    for (const body of [{}, { name: "" }, { name: "Pasta", unknown: true },
    { name: "Pasta", tags: "Dinner" }, { name: "Pasta", tags: ["Dinner", " Dinner "] },
    { name: "Pasta", photo: "javascript:alert(1)" }, { name: "Pasta", link: "javascript:alert(1)" },
    { name: "Pasta", author: "other" }, { name: "Pasta", author: null },
    { name: "Pasta", verified: "false" }, { name: "Pasta", verified: 0 },
    { name: "Pasta", preparation: ["Boil"] }]) {
        assert.equal((await request(cooking, "/api/recipes", "POST", body, recipeKey)).status, 400);
    }
    notion().post("/v1/pages", (body) => body.parent.database_id === recipeDatabase &&
        body.properties.name.title[0].text.content === "Pasta" &&
        body.properties.author.select.name === "hers" &&
        body.properties.verified.checkbox === true &&
        body.properties.preparation.rich_text[0].text.content === "Boil" &&
        body.properties.tags.multi_select[0].name === "Dinner" &&
        body.properties.photo.files[0].external.url === "https://example.com/photo.jpg" &&
        body.properties.link.url === "https://example.com/pasta" &&
        body.properties.ingredients.rich_text.length === 2 &&
        body.properties.ingredients.rich_text[0].text.content.length === 2000).reply(200, recipe);
    const result = await request(cooking, "/api/recipes", "POST", {
        name: "Pasta", ingredients: "x".repeat(2001), preparation: "Boil", tags: ["Dinner"],
        author: "hers", verified: true,
        photo: "https://example.com/photo.jpg", link: "https://example.com/pasta",
    }, recipeKey);
    assert.equal(result.status, 201);
    assert.equal(result.body.name, "Pasta");
});

test("recipes can be read, patched, cleared, and deleted", async () => {
    notion().get(`/v1/pages/${testPageId}`).times(3).reply(200, recipe);
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`)).body.name, "Pasta");

    notion().patch(`/v1/pages/${testPageId}`, {
        properties: {
            ingredients: { rich_text: [] }, preparation: { rich_text: [] },
            author: { select: null }, verified: { checkbox: false },
            tags: { multi_select: [] }, photo: { files: [] }, link: { url: null },
        },
    }).reply(200, recipe);
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`, "PATCH", {
        ingredients: "", preparation: "", tags: [], photo: "", link: "",
        author: "", verified: false,
    }, recipeKey)).status, 200);

    notion().patch(`/v1/pages/${testPageId}`, { in_trash: true }).reply(200, { id: testPageId });
    assert.equal((await request(cooking, `/api/recipes/${testPageId}`, "DELETE", undefined, recipeKey)).body.deleted, true);
});

test("editing text leaves uploaded photos untouched and reads external photo URLs", async () => {
    const updated = {
        ...recipe, properties: {
            ...recipe.properties,
            photo: { files: [{ type: "external", external: { url: "https://example.com/photo.jpg" } }] },
        },
    };
    notion().get(`/v1/pages/${testPageId}`).reply(200, recipe);
    notion().patch(`/v1/pages/${testPageId}`, {
        properties: { preparation: { rich_text: [{ text: { content: "Boil\nServe" } }] } },
    }).reply(200, updated);
    const result = await request(cooking, `/api/recipes/${testPageId}`, "PATCH", { preparation: "Boil\nServe" }, recipeKey);
    assert.equal(result.status, 200);
    assert.equal(result.body.photo, "https://example.com/photo.jpg");
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

test("Notion validation failures include the diagnostic needed to fix a rejected edit", async () => {
    const message = "link is not a property that exists.";
    notion().get(`/v1/pages/${testPageId}`).reply(200, recipe);
    notion().patch(`/v1/pages/${testPageId}`, { properties: { link: { url: null } } })
        .reply(400, { object: "error", status: 400, code: "validation_error", message });
    const result = await request(cooking, `/api/recipes/${testPageId}`, "PATCH", { link: "" }, recipeKey);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "Invalid recipe details.", details: message });
});
