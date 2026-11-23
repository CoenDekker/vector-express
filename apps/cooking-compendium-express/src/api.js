import express, { Router } from "express";
import serverless from "serverless-http";
import cors from "cors";
import { Client } from "@notionhq/client";

const api = express();
const router = Router();
const textFields = ["description", "ingredients", "instructions", "source"];
const tagFields = ["category", "cuisine", "tags"];
const numberFields = ["servings", "prepTime", "cookTime", "rating"];
const fields = ["name", "coverUrl", ...textFields, ...tagFields, ...numberFields];

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
        name: properties.title?.title?.map((text) => text.plain_text).join("") || "",
        image: properties.cover?.files?.[0]?.external?.url || properties.cover?.files?.[0]?.file?.url || "",
    };
    for (const field of textFields) {
        recipe[field] = properties[field]?.rich_text?.map((text) => text.plain_text).join("") || "";
    }
    for (const field of tagFields) {
        recipe[field] = properties[field]?.multi_select?.map((option) => option.name) || [];
    }
    for (const field of numberFields) {
        recipe[field] = properties[field]?.number ?? null;
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
        if (numberFields.includes(field)) {
            if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
                throw new Error(`${field} must be a non-negative number or null.`);
            }
            properties[field] = { number: value };
        } else if (tagFields.includes(field)) {
            if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || !tag.trim()) ||
                new Set(value.map((tag) => tag.trim())).size !== value.length) {
                throw new Error(`${field} must be an array of unique non-empty strings.`);
            }
            properties[field] = { multi_select: value.map((name) => ({ name: name.trim() })) };
        } else if (field === "coverUrl") {
            if (typeof value !== "string") throw new Error("coverUrl must be an HTTP(S) URL or an empty string.");
            if (!value) {
                properties.cover = { files: [] };
            } else {
                let url;
                try { url = new URL(value); } catch { throw new Error("coverUrl must be an HTTP(S) URL."); }
                if (!["http:", "https:"].includes(url.protocol)) throw new Error("coverUrl must be an HTTP(S) URL.");
                properties.cover = { files: [{ name: "cover", type: "external", external: { url: url.href } }] };
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
            properties[field === "name" ? "title" : field] = { [type]: chunks };
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
                sorts: [{ property: "title", direction: "ascending" }],
                ...(req.path === "/recipes/search"
                    ? { filter: { property: "title", title: { contains: req.query.name.trim() } } } : {}),
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
        res.set("Cache-Control", "public, max-age=300").json(Object.fromEntries(
            tagFields.map((field) => [field, database.properties?.[field]?.multi_select?.options?.map((option) => option.name) || []])
        ));
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
router.delete("/recipes/:id", loadRecipe, async (req, res, next) => {
    try {
        await res.locals.notion.pages.update({ page_id: req.params.id, in_trash: true });
        res.json({ id: req.params.id, deleted: true });
    } catch (error) {
        next(error);
    }
});

api.use((error, req, res, next) => {
    if (error.type === "entity.parse.failed" || error.code === "validation_error") {
        return res.status(400).json({ error: "Invalid recipe details." });
    }
    console.error("Cooking Compendium request failed", error);
    res.status(500).json({ error: "Unable to process Cooking Compendium request." });
});

export const handler = serverless(api);
