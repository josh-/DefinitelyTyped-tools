import assert = require("assert");
import { emptyDir } from "fs-extra";
import * as yargs from "yargs";

import { FS, getDefinitelyTyped } from "./get-definitely-typed";
import { Options } from "./lib/common";
import { CachedNpmInfoClient, NpmPublishClient, UncachedNpmInfoClient } from "./lib/npm-client";
import { AllPackages, NotNeededPackage, readNotNeededPackages, TypingsData } from "./lib/packages";
import { outputDirPath, validateOutputPath } from "./lib/settings";
import { fetchAndProcessNpmInfo, Semver } from "./lib/versions";
import { npmInstallFlags, readJson, sleep, writeFile, writeJson } from "./util/io";
import { logger, writeLog } from "./util/logging";
import { computeHash, execAndThrowErrors, joinPaths, logUncaughtErrors } from "./util/util";

const packageName = "types-registry";
const registryOutputPath = joinPaths(outputDirPath, packageName);
const readme =
    `This package contains a listing of all packages published to the @types scope on NPM.
Generated by [types-publisher](https://github.com/Microsoft/types-publisher).`;

if (!module.parent) {
    const dry = !!yargs.argv.dry;
    logUncaughtErrors(async () => {
        const dt = await getDefinitelyTyped(Options.defaults);
        await publishRegistry(dt, await AllPackages.read(dt), dry, new UncachedNpmInfoClient());
    });
}

export default async function publishRegistry(dt: FS, allPackages: AllPackages, dry: boolean, client: UncachedNpmInfoClient): Promise<void> {
    const [log, logResult] = logger();
    log("=== Publishing types-registry ===");

    const { version: oldVersion, highestSemverVersion, contentHash: oldContentHash, lastModified } = await fetchAndProcessNpmInfo(packageName, client);

    // Don't include not-needed packages in the registry.
    const registryJsonData = await CachedNpmInfoClient.with(client, cachedClient => generateRegistry(allPackages.allLatestTypings(), cachedClient));
    const registry = JSON.stringify(registryJsonData);
    const newContentHash = computeHash(registry);

    assert.strictEqual(oldVersion.major, 0);
    assert.strictEqual(oldVersion.minor, 1);
    const newVersion = `0.1.${oldVersion.patch + 1}`;
    const packageJson = generatePackageJson(newVersion, newContentHash);
    await generate(registry, packageJson);

    const publishClient = () => NpmPublishClient.create({ defaultTag: "next" });
    if (!highestSemverVersion.equals(oldVersion)) {
        // There was an error in the last publish and types-registry wasn't validated.
        // This may have just been due to a timeout, so test if types-registry@next is a subset of the one we're about to publish.
        // If so, we should just update it to "latest" now.
        log("Old version of types-registry was never tagged latest, so updating");
        await validateIsSubset(await readNotNeededPackages(dt));
        await (await publishClient()).tag(packageName, highestSemverVersion.versionString, "latest");
    } else if (oldContentHash !== newContentHash && isAWeekAfter(lastModified)) {
        log("New packages have been added, so publishing a new registry.");
        await publish(await publishClient(), packageJson, newVersion, dry);
    } else {
        const reason = oldContentHash === newContentHash ? "Was modified less than a week ago" : "No new packages published";
        log(`${reason}, so no need to publish new registry.`);
        // Just making sure...
        await validate();
    }

    await writeLog("publish-registry.md", logResult());
}

const millisecondsPerDay = 1000 * 60 * 60 * 24;
function isAWeekAfter(time: Date): boolean {
    const diff = Date.now() - time.getTime();
    const days = diff / millisecondsPerDay;
    return days > 7;
}

async function generate(registry: string, packageJson: {}): Promise<void> {
    await emptyDir(registryOutputPath);
    await writeOutputJson("package.json", packageJson);
    await writeOutputFile("index.json", registry);
    await writeOutputFile("README.md", readme);

    function writeOutputJson(filename: string, content: object): Promise<void> {
        return writeJson(outputPath(filename), content);
    }

    function writeOutputFile(filename: string, content: string): Promise<void> {
        return writeFile(outputPath(filename), content);
    }

    function outputPath(filename: string): string {
        return joinPaths(registryOutputPath, filename);
    }
}

async function publish(client: NpmPublishClient, packageJson: {}, version: string, dry: boolean): Promise<void> {
    await client.publish(registryOutputPath, packageJson, dry);
    // Sleep for 60 seconds to let NPM update.
    await sleep(60);
    // Don't set it as "latest" until *after* it's been validated.
    await validate();
    await client.tag(packageName, version, "latest");
}

async function installForValidate(): Promise<void> {
    await emptyDir(validateOutputPath);
    await writeJson(joinPaths(validateOutputPath, "package.json"), {
        name: "validate",
        version: "0.0.0",
        description: "description",
        readme: "",
        license: "",
        repository: {},
    });

    const npmPath = joinPaths(__dirname, "..", "node_modules", "npm", "bin", "npm-cli.js");
    const err = (await execAndThrowErrors(`node ${npmPath} install types-registry@next ${npmInstallFlags}`, validateOutputPath)).trim();
    if (err) {
        console.error(err);
    }
}

const validateTypesRegistryPath = joinPaths(validateOutputPath, "node_modules", "types-registry");

async function validate(): Promise<void> {
    await installForValidate();
    assertJsonNewer(
        await readJson(joinPaths(registryOutputPath, "index.json")),
        await readJson(joinPaths(validateTypesRegistryPath, "index.json")));
}

async function validateIsSubset(notNeeded: ReadonlyArray<NotNeededPackage>): Promise<void> {
    await installForValidate();
    const indexJson = "index.json";
    const actual = await readJson(joinPaths(validateTypesRegistryPath, indexJson)) as Registry;
    const expected = await readJson(joinPaths(registryOutputPath, indexJson)) as Registry;
    for (const key in actual.entries) {
        if (!(key in expected.entries) && !notNeeded.some(p => p.name === key)) {
            throw new Error(`Actual types-registry has unexpected key ${key}`);
        }
    }
}

function assertJsonNewer(newer: { [s: string]: any }, older: { [s: string]: any }, parent = "") {
    for (const key of Object.keys(older)) {
        assert(newer.hasOwnProperty(key), `${key} in ${parent} was not found in newer`);
        switch (typeof newer[key]) {
            case "string":
                const newerver = Semver.tryParse(newer[key])
                const olderver = Semver.tryParse(older[key])
                const condition = newerver && olderver ?
                    newerver.greaterThan(olderver) || newerver.equals(olderver) :
                    newer[key] >= older[key]
                assert(condition, `${key} in ${parent} did not match: newer[key] (${newer[key]}) < older[key] (${older[key]})`);
                break;
            case "number":
                assert(newer[key] >= older[key], `${key} in ${parent} did not match: newer[key] (${newer[key]}) < older[key] (${older[key]})`);
                break;
            case "boolean":
                assert(newer[key] === older[key], `${key} in ${parent} did not match: newer[key] (${newer[key]}) !== older[key] (${older[key]})`);
                break;
            default:
                assertJsonNewer(newer[key], older[key], key);
        }
    }
}

function generatePackageJson(version: string, typesPublisherContentHash: string): object {
    return {
        name: packageName,
        version,
        description: "A registry of TypeScript declaration file packages published within the @types scope.",
        repository: {
            type: "git",
            url: "https://github.com/Microsoft/types-publisher.git",
        },
        keywords: [
            "TypeScript",
            "declaration",
            "files",
            "types",
            "packages",
        ],
        author: "Microsoft Corp.",
        license: "MIT",
        typesPublisherContentHash,
    };
}

interface Registry {
    readonly entries: {
        readonly [packageName: string]: {
            readonly [distTags: string]: string
        }
    };
}
async function generateRegistry(typings: ReadonlyArray<TypingsData>, client: CachedNpmInfoClient): Promise<Registry> {
    const entries: { [packageName: string]: { [distTags: string]: string } } = {};
    for (const typing of typings) {
        // Unconditionally use cached info, this should have been set in calculate-versions so should be recent enough.
        const info = client.getNpmInfoFromCache(typing.fullEscapedNpmName);
        if (!info) {
            const missings = typings.filter(t => !client.getNpmInfoFromCache(t.fullEscapedNpmName)).map(t => t.fullEscapedNpmName);
            throw new Error(`${missings} not found in ${client.formatKeys()}`);
        }
        entries[typing.name] = filterTags(info.distTags);
    }
    return { entries };

    function filterTags(tags: Map<string, string>): { readonly [tag: string]: string; } {
        const latestTag = "latest";
        const latestVersion = tags.get(latestTag);
        const out: { [tag: string]: string } = {};
        tags.forEach((value, tag) => {
            if (tag === latestTag || value !== latestVersion) {
                out[tag] = value;
            }
        });
        return out;
    }
}
