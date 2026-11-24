import express, { Router } from "express";
import serverless from "serverless-http";
import cors from "cors";
import { Client } from "@notionhq/client";

const api = express();
const router = Router();
const textFields = ["ingredients", "preparation"];
const fields = ["name", "tags", ...textFields, "photo", "link"];

api.use(cors());
api.use("/api", router);
router.get("/hello", (req, res) => res.send("Hello World!"));
router.use("/recipes", (req, res, next) => {
    if (["POST", "PATCH", "DELETE"].includes(req.method) &&
        (!process.env.COOKING_COMPENDIUM_WRITE_KEY ||
            req.get("x-api-key") !== process.env.COOKING_COMPENDIUM_WRITE_KEY)) {
        return res.status(401).json({ error: "Unauthorized." });
    }
    if (!process.env.NOTION_COOKING_COMPENDIUM_TOKEN || !process.env.NOTION_COOKING_COMPENDIUM_DATABASE_ID) {
        return res.status(503).json({ error: "Cooking Compendium access is not configured." });
    }
    res.locals.notion = new Client({ auth: process.env.NOTION_COOKING_COMPENDIUM_TOKEN });
    res.locals.databaseId = process.env.NOTION_COOKING_COMPENDIUM_DATABASE_ID;
    next();
});

function getRecipe(page) {
    const properties = page.properties || {};
    const recipe = {
        id: page.id,
        name: properties.name?.title?.map((text) => text.plain_text).join("") || "",
        tags: properties.tags?.multi_select?.map((option) => option.name) || [],
        photo: properties.photo?.files?.[0]?.external?.url || properties.photo?.files?.[0]?.file?.url || "",
        link: properties.link?.url || "",
    };
    for (const field of textFields) {
        recipe[field] = properties[field]?.rich_text?.map((text) => text.plain_text).join("") || "";
    }
    return recipe;
}

function getProperties(changes, creating = false) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
        !Object.keys(changes).length || Object.keys(changes).some((field) => !fields.includes(field))) {
        throw new Error(`Provide one or more of: ${fields.join(", ")}.`);
    }
    if (creating && (typeof changes.name !== "string" || !changes.name.trim())) {
        throw new Error("name is required.");
    }
    const properties = {};
    for (const [field, value] of Object.entries(changes)) {
        if (field === "tags") {
            if (!Array.isArray(value) || value.length > 100 ||
                value.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100) ||
                new Set(value.map((tag) => tag.trim())).size !== value.length) {
                throw new Error("tags must contain up to 100 unique non-empty strings (100 characters max each).");
            }
            properties[field] = { multi_select: value.map((name) => ({ name: name.trim() })) };
        } else if (field === "photo" || field === "link") {
            if (typeof value !== "string" || value.length > 2000) throw new Error(`${field} must be an HTTP(S) URL or an empty string.`);
            if (!value) {
                properties[field] = field === "photo" ? { files: [] } : { url: null };
            } else {
                let url;
                try { url = new URL(value); } catch { throw new Error(`${field} must be an HTTP(S) URL.`); }
                if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field} must be an HTTP(S) URL.`);
                properties[field] = field === "photo"
                    ? { files: [{ name: "photo", type: "external", external: { url: url.href } }] }
                    : { url: url.href };
            }
        } else {
            if (typeof value !== "string" || (field === "name" && !value.trim())) {
                throw new Error(`${field} must be ${field === "name" ? "a non-empty string" : "a string"}.`);
            }
            const type = field === "name" ? "title" : "rich_text";
            const content = value.trim();
            const chunks = [];
            for (let offset = 0; offset < content.length; offset += 2000) {
                chunks.push({ text: { content: content.slice(offset, offset + 2000) } });
            }
            if (chunks.length > 100) throw new Error(`${field} is too long.`);
            properties[field] = { [type]: chunks };
        }
    }
    return properties;
}

async function listRecipes(req, res, next) {
    if (req.path === "/recipes/search" && (typeof req.query.name !== "string" || !req.query.name.trim())) {
        return res.status(400).json({ error: "name is required." });
    }
    try {
        const recipes = [];
        let cursor;
        do {
            const page = await res.locals.notion.databases.query({
                database_id: res.locals.databaseId,
                page_size: 100,
                start_cursor: cursor,
                sorts: [{ property: "name", direction: "ascending" }],
                ...(req.path === "/recipes/search"
                    ? { filter: { property: "name", title: { contains: req.query.name.trim() } } } : {}),
            });
            recipes.push(...page.results.map(getRecipe));
            cursor = page.next_cursor;
        } while (cursor);
        res.json(recipes);
    } catch (error) {
        next(error);
    }
}

async function loadRecipe(req, res, next) {
    try {
        const page = await res.locals.notion.pages.retrieve({ page_id: req.params.id });
        if (page.parent?.database_id?.replace(/-/g, "") !== res.locals.databaseId.replace(/-/g, "") ||
            page.archived || page.in_trash) {
            return res.status(404).json({ error: "Recipe not found." });
        }
        res.locals.page = page;
        next();
    } catch (error) {
        if (["object_not_found", "validation_error"].includes(error.code)) {
            return res.status(404).json({ error: "Recipe not found." });
        }
        next(error);
    }
}

router.get("/recipes", listRecipes);
router.get("/recipes/search", listRecipes);
router.get("/recipes/options", async (req, res, next) => {
    try {
        const database = await res.locals.notion.databases.retrieve({ database_id: res.locals.databaseId });
        res.set("Cache-Control", "public, max-age=300").json({
            tags: database.properties?.tags?.multi_select?.options?.map((option) => option.name) || [],
        });
    } catch (error) {
        next(error);
    }
});
router.get("/recipes/:id", loadRecipe, (req, res) => res.json(getRecipe(res.locals.page)));

function validateRecipe(creating) {
    return (req, res, next) => {
        try {
            res.locals.properties = getProperties(req.body, creating);
            next();
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };
}

router.post("/recipes", express.json(), validateRecipe(true), async (req, res, next) => {
    try {
        const page = await res.locals.notion.pages.create({
            parent: { database_id: res.locals.databaseId },
            properties: res.locals.properties,
        });
        res.status(201).json(getRecipe(page));
    } catch (error) {
        next(error);
    }
});
router.patch("/recipes/:id", express.json(), validateRecipe(false), loadRecipe, async (req, res, next) => {
    try {
        const page = await res.locals.notion.pages.update({ page_id: req.params.id, properties: res.locals.properties });
        res.json(getRecipe(page));
    } catch (error) {
        next(error);
    }
});
router.delete("/recipes/tags/:tag", async (req, res) => {
    const tag = req.params.tag.trim();
    if (!tag || tag.length > 100) return res.status(400).json({ error: "A tag name is required (100 characters max)." });
    const notion = res.locals.notion;
    const databaseId = res.locals.databaseId;
    let updated = 0;
    try {
        const database = await notion.databases.retrieve({ database_id: databaseId });
        const options = database.properties?.tags?.multi_select?.options || [];
        const option = options.find((entry) => entry.name.toLocaleLowerCase() === tag.toLocaleLowerCase());
        if (!option) return res.status(404).json({ error: "Tag not found." });
        const pages = [];
        let cursor;
        do {
            const result = await notion.databases.query({
                database_id: databaseId, page_size: 100, start_cursor: cursor,
                filter: { property: "tags", multi_select: { contains: option.name } },
            });
            pages.push(...result.results);
            cursor = result.next_cursor;
        } while (cursor);
        for (const page of pages) {
            const tags = (page.properties?.tags?.multi_select || [])
                .filter((entry) => entry.name.toLocaleLowerCase() !== option.name.toLocaleLowerCase())
                .map((entry) => entry.id ? { id: entry.id } : { name: entry.name });
            await notion.pages.update({ page_id: page.id, properties: { tags: { multi_select: tags } } });
            updated++;
        }
        const current = await notion.databases.retrieve({ database_id: databaseId });
        const remaining = (current.properties?.tags?.multi_select?.options || [])
            .filter((entry) => entry.name.toLocaleLowerCase() !== option.name.toLocaleLowerCase());
        await notion.databases.update({ database_id: databaseId, properties: { tags: { multi_select: { options: remaining } } } });
        res.set("Cache-Control", "no-store").json({ tag: option.name, deleted: true, updated, tags: remaining.map((entry) => entry.name) });
    } catch (error) {
        console.error("Cooking Compendium tag removal failed:", error.message);
        res.status(502).json({ error: `Tag removal stopped after updating ${updated} recipes. Some recipes may still have the tag. Retry to finish removing it.`, updated, deleted: false });
    }
});
router.delete("/recipes/:id", loadRecipe, async (req, res, next) => {
    try {
        await res.locals.notion.pages.update({ page_id: req.params.id, in_trash: true });
        res.json({ id: req.params.id, deleted: true });
    } catch (error) {
        next(error);
    }
});

api.use((error, req, res, next) => {
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid recipe details." });
    }
    if (error.code === "validation_error") {
        console.error("Notion rejected Cooking Compendium request:", error.message);
        return res.status(400).json({ error: "Invalid recipe details.", details: error.message });
    }
    console.error("Cooking Compendium request failed", error);
    res.status(500).json({ error: "Unable to process Cooking Compendium request." });
});

export const handler = serverless(api);
