import assert from "node:assert/strict";
import { afterEach } from "node:test";
import nock from "nock";

export const testPageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

export function setupMockNotion() {
    nock.disableNetConnect();
    afterEach(() => {
        const pending = nock.pendingMocks();
        nock.cleanAll();
        assert.deepEqual(pending, [], "All expected Notion calls should be made");
    });
}

export async function request(handler, path, method = "GET", body, key, contentType = "application/json") {
    const url = new URL(path, "https://example.test");
    const response = await handler({
        httpMethod: method,
        path: url.pathname,
        headers: { "content-type": contentType, ...(key ? { "x-api-key": key } : {}) },
        queryStringParameters: Object.fromEntries(url.searchParams),
        requestContext: {},
        body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
        isBase64Encoded: false,
    }, {});
    return {
        status: response.statusCode,
        body: response.headers["content-type"]?.includes("application/json")
            ? JSON.parse(response.body) : response.body,
    };
}

export function notion() {
    return nock("https://api.notion.com");
}

export function page(databaseId, properties = {}) {
    return { id: testPageId, parent: { database_id: databaseId }, archived: false, properties };
}