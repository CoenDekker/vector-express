# Vector Express

Shared API base URL: `https://vector-express.netlify.app`.

# Install

npm install -g netlify-cli

npm install

This question has more than 30 answers, most suggesting to either downgrade Node.js to pre v17 or to use the legacy SSL provider. Both of those solutions are hacks that leave your builds open to security threats.

Reason For The Error
In Node.js v17, the Node.js developers closed a security hole in the SSL provider. This fix was a breaking change that corresponded with similar breaking changes in the SSL packages in NPM. When you attempt to use SSL in Node.js v17 or later without also upgrading those SSL packages in your package.json, then you will see this error.

The Correct (safe) Solution (for npm users)
Use an up-to-date version of Node.js, and also use packages that are up-to-date with security fixes.

You can first try an update to see if that solves the problem:

npm update
If that is not enough, for many people, the following command will fix the issue:

npm audit fix --force
However, be aware that, for complex builds, the above command will pull in breaking security fixes that can potentially break your build.

Note for Yarn users
Yarn users can use yarn-audit-fix which can be run without installing as a dependency via

npm_config_yes=true npx yarn-audit-fix
or windows powershell:

$env:npm_config_yes = 1; npx yarn-audit-fix
A less heavy-handed (also correct) solution for Webpack
In your Webpack config, set either of the following: (See the ouput.hashFunction docs)

A. (Webpack v5) Set output.hashFunction = 'xxhash64'.
B. (Webpack v4) This will depend on what hash algorithms nodejs supports on your system. Some common options you can try are output.hashFunction = 'sha512' or output.hashFunction = 'sha256'.

# deploy

npm run build

# Compendium APIs

Three separate Express API modules in one npm workspace, deployed together to
one Netlify site named `vector-express`:

| Workspace                    | Source                                | Routes          | Local Port |
| ---------------------------- | ------------------------------------- | --------------- | ---------- |
| `gamelist-express`           | `apps/gamelist-express/src`           | `/api/gamelist` | 8888       |
| `latelegends-express`        | `apps/latelegends-express/src`        | `/api/ll`       | 8889       |
| `cooking-compendium-express` | `apps/cooking-compendium-express/src` | `/api/recipes`  | 8890       |

The combined site exposes `GET /api/hello`. Existing route paths and response
formats are preserved. All three APIs share the same domain:

- `https://vector-express.netlify.app/api/gamelist`
- `https://vector-express.netlify.app/api/ll/all`
- `https://vector-express.netlify.app/api/recipes`

## Install, Build, Test

Use Node.js 22.12+ (a supported LTS release is recommended) and npm 10+.

```sh
npm ci
npm run build
npm test
```

`npm run build` builds the modules and the combined root `functions/api.cjs`
using esbuild. The root `dist` and `functions` directories are deployed together.
Tests live with their app under `apps/*/test`. They invoke the built serverless
handlers with mocked Notion calls, without credentials. The root `npm test`
builds and runs all app tests; to run one app's tests:

```sh
npm test --workspace gamelist-express
npm test --workspace latelegends-express
npm test --workspace cooking-compendium-express
```

Select a single app with npm's workspace flag:

```sh
npm run build --workspace gamelist-express
npm start --workspace latelegends-express
npm start --workspace cooking-compendium-express
```

`npm start` starts the combined API at `http://localhost:8888`. Local development
uses Netlify Dev; put secrets in an untracked root `.env`, or configure them on
the linked Netlify site. Workspace start commands run individual modules separately.

## Deploy

Keep the existing Netlify site. In its domain settings, change the default
Netlify subdomain to `vector-express` (subject to availability). This retains
the site's ID and environment variables and changes its default URL to
`https://vector-express.netlify.app`. Renaming the npm package alone does not
rename the live Netlify site.

Authenticate and link this repository to that existing site once:

```sh
npx netlify login
npx netlify link --filter vector-express
npm run deploy
```

The root deploy command builds and publishes all three APIs in one deployment
to the linked site. For CI, configure `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID`.
For Git-connected deploys, keep the site's base and package directory at the
repository root; the root Netlify configuration handles the combined build,
functions, and `/api/*` rewrite. Do not select an app directory for this site.

Configure all these variables on the single site (including Functions scope):

| API                | Variable                                | Purpose                                                |
| ------------------ | --------------------------------------- | ------------------------------------------------------ |
| Gamelist           | `NOTION_GAMELIST_TOKEN`                 | Integration access to the existing game database       |
| Gamelist           | `GAMELIST_WRITE_KEY`                    | Private `x-api-key` for game writes                    |
| Late Legends       | `NOTION_LL_TOKEN`                       | Integration access to the existing LL database         |
| Late Legends       | `NOTION_LL_DATABASE_ID`                 | Optional database override; existing ID is the default |
| Cooking Compendium | `NOTION_COOKING_COMPENDIUM_TOKEN`       | Integration access to the recipe database              |
| Cooking Compendium | `NOTION_COOKING_COMPENDIUM_DATABASE_ID` | Required recipe database ID                            |
| Cooking Compendium | `COOKING_COMPENDIUM_WRITE_KEY`          | Private `x-api-key` for recipe writes                  |

Share each Notion database with its integration. Generate write keys with
`openssl rand -hex 32`; never expose write keys or Notion tokens in browser code.
Previously committed secrets should be rotated, since deleting them does not
remove them from Git history. LL's legacy write endpoints retain their existing
authentication behavior; this split does not add write-key protection to LL.

## Gamelist

The existing Notion schema and database remain unchanged.

| Method | Route                              | Purpose                             |
| ------ | ---------------------------------- | ----------------------------------- |
| GET    | `/api/gamelist`                    | Full list                           |
| GET    | `/api/gamelist/:cursor`            | Page (`initial` for the first page) |
| GET    | `/api/gamelist/search?name=Rayman` | Search by title                     |
| GET    | `/api/gamelist/options`            | Platform and status options         |
| GET    | `/api/gamelist/game/:id`           | Single game                         |
| POST   | `/api/gamelist`                    | Create game (write key required)    |
| PATCH  | `/api/gamelist/game/:id`           | Edit game (write key required)      |
| DELETE | `/api/gamelist/game/:id`           | Trash game (write key required)     |

Creating a game requires `name`, HTTP(S) `coverUrl`, `platform`, and `status`
(an array of unique non-empty values). Optional fields are `completed` (boolean),
`developer` (up to 200 characters), and `release` (four-digit year, optional trailing `*`).
Status options conventionally include `playing`, `replaying`, `queued`, `finished`,
`unplayed`, `pause`, and `backlog`; multiple values require a Notion Multi-select.
PATCH accepts any of these fields plus `rating` (select value; empty string clears it).
Empty strings also clear `developer` and `release`. Responses use `image` for the cover URL.

```sh
curl -X POST https://vector-express.netlify.app/api/gamelist \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $GAMELIST_WRITE_KEY" \
  -d '{"name":"Example Game","coverUrl":"https://example.com/cover.jpg","platform":"PC","status":["queued"]}'
```

The optional IGDB HTTP examples use local `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`,
and `IGDB_ACCESS_TOKEN`; they are not needed by the deployed APIs.

## Late Legends

| Method | Route                          | Purpose                                         |
| ------ | ------------------------------ | ----------------------------------------------- |
| GET    | `/api/ll/:userid`              | Builds for a user (`all` for everyone)          |
| POST   | `/api/ll/add/`                 | Create or update a build by `userid` and `name` |
| GET    | `/api/ll/delete/:userid/:name` | Legacy delete endpoint                          |

JSON and legacy text/plain JSON bodies are accepted for add/update. The existing
LL build schema is unchanged; request examples and fixtures live in the LL app.

## Cooking Compendium

Create a separate Notion database with these exact property names and types:

| Property       | Notion Type   | API Field                               |
| -------------- | ------------- | --------------------------------------- |
| `title`        | Title         | `name` (required on create)             |
| `cover`        | Files & media | `coverUrl` on writes, `image` on reads  |
| `description`  | Rich text     | `description`                           |
| `ingredients`  | Rich text     | `ingredients` (newline-separated text)  |
| `instructions` | Rich text     | `instructions` (newline-separated text) |
| `source`       | Rich text     | `source`                                |
| `category`     | Multi-select  | `category` (string array)               |
| `cuisine`      | Multi-select  | `cuisine` (string array)                |
| `tags`         | Multi-select  | `tags` (string array)                   |
| `servings`     | Number        | `servings`                              |
| `prepTime`     | Number        | `prepTime` (minutes)                    |
| `cookTime`     | Number        | `cookTime` (minutes)                    |
| `rating`       | Number        | `rating`                                |

All fields except `name` are optional on create. Numbers must be non-negative;
`null` clears them. Empty strings clear text/cover fields, and empty arrays clear
tags. PATCH leaves unspecified fields unchanged. Long text is split into Notion's
2,000-character rich-text chunks, up to 100 chunks per property.

| Method | Route                            | Purpose                            |
| ------ | -------------------------------- | ---------------------------------- |
| GET    | `/api/recipes`                   | All recipes, sorted by title       |
| GET    | `/api/recipes/search?name=pasta` | Search by title                    |
| GET    | `/api/recipes/options`           | Category, cuisine, and tag options |
| GET    | `/api/recipes/:id`               | Single recipe                      |
| POST   | `/api/recipes`                   | Create recipe (write key required) |
| PATCH  | `/api/recipes/:id`               | Edit recipe (write key required)   |
| DELETE | `/api/recipes/:id`               | Trash recipe (write key required)  |

```sh
curl -X POST https://vector-express.netlify.app/api/recipes \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $COOKING_COMPENDIUM_WRITE_KEY" \
  -d '{"name":"Tomato pasta","ingredients":"200g pasta\n400g tomatoes","instructions":"Boil pasta.\nSimmer tomatoes.\nCombine.","category":["Dinner"],"servings":2,"cookTime":20}'
```

Writes without a valid key return `401`, invalid data returns `400`, missing or
foreign/archived recipes return `404`, and missing Notion configuration returns
`503`. Listing and search follow all Notion pagination cursors.
