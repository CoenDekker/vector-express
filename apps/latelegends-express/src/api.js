import express, { Router } from "express";
import serverless from "serverless-http";
import cors from "cors";
import { Client } from "@notionhq/client";
import { getLLBuild, getPropertiesObject } from "./ll-utils.js";

const api = express();
const router = Router();
const databaseId = process.env.NOTION_LL_DATABASE_ID || "1166b583229a80f4a431e9b43908ff61";

api.use(cors());
api.use("/api", router);
router.get("/hello", (req, res) => res.send("Hello World!"));
router.use("/ll", (req, res, next) => {
    if (!process.env.NOTION_LL_TOKEN) {
        return res.status(503).json({ error: "LL access is not configured." });
    }
    next();
});

async function getNotionLLData(client) {
    const results = [];
    let cursor;
    do {
        const page = await client.databases.query({
            database_id: databaseId,
            start_cursor: cursor,
            sorts: [],
        });
        results.push(...page.results);
        cursor = page.next_cursor;
    } while (cursor);
    return results;
}

router.get("/ll/:userid", async (req, res, next) => {
    try {
        const client = new Client({ auth: process.env.NOTION_LL_TOKEN });
        const entries = await getNotionLLData(client);
        res.json(entries
            .filter((entry) => req.params.userid === "all" ||
                entry.properties.userid.rich_text[0]?.plain_text === req.params.userid)
            .map(getLLBuild));
    } catch (error) {
        next(error);
    }
});

router.post("/ll/add/", express.json(), express.text(), async (req, res, next) => {
    try {
        const requestBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        if (!requestBody || typeof requestBody.userid !== "string" || !requestBody.userid.trim() ||
            typeof requestBody.name !== "string" || !requestBody.name.trim()) {
            return res.status(400).json({ error: "userid and name are required." });
        }
        const client = new Client({ auth: process.env.NOTION_LL_TOKEN });
        const entries = await getNotionLLData(client);
        const existing = entries.find((entry) =>
            entry.properties.userid.rich_text[0]?.plain_text === requestBody.userid &&
            entry.properties.name.title[0]?.plain_text === requestBody.name);
        const properties = getPropertiesObject(requestBody);
        if (existing) {
            await client.pages.update({ page_id: existing.id, properties });
        } else {
            await client.pages.create({ parent: { database_id: databaseId }, properties });
        }
        res.json({ message: "New user was added to the list" });
    } catch (error) {
        next(error);
    }
});

router.get("/ll/delete/:userid/:name", async (req, res, next) => {
    try {
        const client = new Client({ auth: process.env.NOTION_LL_TOKEN });
        const entries = await getNotionLLData(client);
        const existing = entries.find((entry) =>
            entry.properties.userid.rich_text[0]?.plain_text === req.params.userid &&
            entry.properties.name.title[0]?.plain_text === req.params.name);
        if (!existing) {
            return res.json({ message: `${req.params.name} was not found, nothing to delete!` });
        }
        const response = await client.pages.update({ page_id: existing.id, in_trash: true });
        res.json({
            message: response.in_trash
                ? `${req.params.name} has been removed from ${req.params.userid}`
                : `Something went wrong when deleting ${req.params.name}, nothing deleted...`
        });
    } catch (error) {
        next(error);
    }
});

api.use((error, req, res, next) => {
    if (error instanceof SyntaxError) {
        return res.status(400).json({ error: "Invalid JSON." });
    }
    console.error("Late Legends request failed", error);
    res.status(500).json({ error: "Unable to process Late Legends request." });
});

export const handler = serverless(api);
