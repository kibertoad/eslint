/**
 * @fileoverview Define classes what use the in-memory file system.
 *
 * This provides utilities to test `ConfigArrayFactory` and `FileEnumerator`.
 *
 * - `defineConfigArrayFactoryWithInmemoryFileSystem({ cwd, files })`
 * - `defineFileEnumeratorWithInmemoryFileSystem({ cwd, files })`
 *
 * Both functions define the class `ConfigArrayFactory` or `FileEnumerator` with
 * the in-memory file system. Those search config files, parsers, and plugins in
 * the `files` option via the in-memory file system.
 *
 * For each test case, it makes more readable if we define minimal files the
 * test case requires.
 *
 * For example:
 *
 * ```js
 * const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
 *     files: {
 *         "node_modules/eslint-config-foo/index.js": `
 *             module.exports = {
 *                 parser: "./parser",
 *                 rules: {
 *                     "no-undef": "error"
 *                 }
 *             }
 *         `,
 *         "node_modules/eslint-config-foo/parser.js": `
 *             module.exports = {
 *                 parse() {}
 *             }
 *         `,
 *         ".eslintrc.json": JSON.stringify({ root: true, extends: "foo" })
 *     }
 * });
 * const factory = new ConfigArrayFactory();
 * const config = factory.loadFile(".eslintrc.json");
 *
 * assert(config[0].name === ".eslintrc.json » eslint-config-foo");
 * assert(config[0].filePath === path.resolve("node_modules/eslint-config-foo/index.js"));
 * assert(config[0].parser.filePath === path.resolve("node_modules/eslint-config-foo/parser.js"));
 *
 * assert(config[1].name === ".eslintrc.json");
 * assert(config[1].filePath === path.resolve(".eslintrc.json"));
 * assert(config[1].root === true);
 * ```
 *
 * @author Toru Nagashima <https://github.com/mysticatea>
 */
"use strict";

// To use TypeScript type annotations for VSCode intellisense.
/* eslint-disable valid-jsdoc */

const path = require("path");
const vm = require("vm");
const MemoryFs = require("metro-memory-fs");
const Proxyquire = require("proxyquire/lib/proxyquire");

const ConfigArrayFactoryPath =
    require.resolve("../../../lib/lookup/config-array-factory");
const FileEnumeratorPath =
    require.resolve("../../../lib/lookup/file-enumerator");
const IgnoredPathsPath =
    require.resolve("../../../lib/lookup/ignored-paths");
const LoadRulesPath =
    require.resolve("../../../lib/lookup/load-rules");
const ESLintAllPath =
    require.resolve("../../../conf/eslint-all");
const ESLintRecommendedPath =
    require.resolve("../../../conf/eslint-recommended");

// Ensure the needed files has been loaded and cached.
require(ConfigArrayFactoryPath);
require(FileEnumeratorPath);
require(IgnoredPathsPath);
require(LoadRulesPath);
require("js-yaml");
require("espree");

// Override `_require` in order to throw runtime errors in stubs.
const ERRORED = Symbol("errored");
const proxyquire = new class extends Proxyquire {
    _require(...args) {
        const retv = super._require(...args); // eslint-disable-line no-underscore-dangle

        if (retv[ERRORED]) {
            throw retv[ERRORED];
        }
        return retv;
    }
}(module).noCallThru().noPreserveCache();

const context = vm.createContext();

/**
 * Check if a given path is an existing file.
 * @param {typeof import("fs")} fs The file system.
 * @param {string} filePath Tha path to a file to check.
 * @returns {boolean} `true` if the file existed.
 */
function isExistingFile(fs, filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch (error) {
        return false;
    }
}

/**
 * Get some paths to test.
 * @param {string} prefix The prefix to try.
 * @returns {string[]} The paths to test.
 */
function getTestPaths(prefix) {
    return [
        path.join(prefix),
        path.join(`${prefix}.js`),
        path.join(prefix, "index.js")
    ];
}

/**
 * Iterate the candidate paths of a given request to resolve.
 * @param {string} request Tha package name or file path to resolve.
 * @param {string} relativeTo Tha path to the file what called this resolving.
 * @returns {IterableIterator<string>} The candidate paths.
 */
function *iterateCandidatePaths(request, relativeTo) {
    if (path.isAbsolute(request)) {
        yield* getTestPaths(request);
        return;
    }
    if (/^\.{1,2}[/\\]/u.test(request)) {
        yield* getTestPaths(path.resolve(path.dirname(relativeTo), request));
        return;
    }

    let prevPath = path.resolve(relativeTo);
    let dirPath = path.dirname(prevPath);

    while (dirPath && dirPath !== prevPath) {
        yield* getTestPaths(path.join(dirPath, "node_modules", request));
        prevPath = dirPath;
        dirPath = path.dirname(dirPath);
    }
}

/**
 * Resolve a given module name or file path relatively in the given file system.
 * @param {typeof import("fs")} fs The file system.
 * @param {string} request Tha package name or file path to resolve.
 * @param {string} relativeTo Tha path to the file what called this resolving.
 * @returns {void}
 */
function fsResolve(fs, request, relativeTo) {
    for (const filePath of iterateCandidatePaths(request, relativeTo)) {
        if (isExistingFile(fs, filePath)) {
            return filePath;
        }
    }

    throw Object.assign(
        new Error(`Cannot find module '${request}'`),
        { code: "MODULE_NOT_FOUND" }
    );
}

/**
 * Compile a JavaScript file.
 * @param {typeof import("fs")} fs The file system.
 * @param {Object} stubs The stubs.
 * @param {string} filePath The path to a JavaScript file to compile.
 * @param {string} content The source code to compile.
 * @returns {any} The exported value.
 */
function compile(fs, stubs, filePath, content) {
    const code = `(function(exports, require, module, __filename, __dirname) { ${content} })`;
    const f = vm.runInContext(code, context);
    const exports = {};
    const module = { exports };

    f.call(
        exports,
        exports,
        request => {
            const modulePath = fsResolve(fs, request, filePath);
            const stub = stubs[modulePath];

            if (stub[ERRORED]) {
                throw stub[ERRORED];
            }
            return stub;
        },
        module,
        filePath,
        path.dirname(filePath)
    );

    return module.exports;
}

/**
 * Import a given file path in the given file system.
 * @param {typeof import("fs")} fs The file system.
 * @param {Object} stubs The stubs.
 * @param {string} absolutePath Tha file path to import.
 * @returns {void}
 */
function fsImportFresh(fs, stubs, absolutePath) {
    if (absolutePath === ESLintAllPath) {
        return require(ESLintAllPath);
    }
    if (absolutePath === ESLintRecommendedPath) {
        return require(ESLintRecommendedPath);
    }

    if (fs.existsSync(absolutePath)) {
        return compile(
            fs,
            stubs,
            absolutePath,
            fs.readFileSync(absolutePath, "utf8")
        );
    }

    throw Object.assign(
        new Error(`Cannot find module '${absolutePath}'`),
        { code: "MODULE_NOT_FOUND" }
    );
}

/**
 * Add support of `recursive` option.
 * @param {typeof import("fs")} fs The in-memory file system.
 * @param {() => string} cwd The current working directory.
 * @returns {void}
 */
function supportMkdirRecursiveOption(fs, cwd) {
    const { mkdirSync } = fs;

    fs.mkdirSync = (filePath, options) => {
        if (typeof options === "object" && options !== null) {
            if (options.recursive) {
                const absolutePath = path.resolve(cwd(), filePath);
                const parentPath = path.dirname(absolutePath);

                if (
                    parentPath &&
                    parentPath !== absolutePath &&
                    !fs.existsSync(parentPath)
                ) {
                    fs.mkdirSync(parentPath, options);
                }
            }
            mkdirSync(filePath, options.mode);
        } else {
            mkdirSync(filePath, options);
        }
    };
}

/**
 * Define stubbed `ConfigArrayFactory` class what uses the in-memory file system.
 * @param {Object} options The options.
 * @param {() => string} [options.cwd] The current working directory.
 * @param {Object} [options.files] The initial files definition in the in-memory file system.
 * @returns {{ fs: typeof import("fs"), ConfigArrayFactory: (typeof import("../../../lib/lookup/config-array-factory"))["ConfigArrayFactory"] }} The stubbed `ConfigArrayFactory` class.
 */
function defineConfigArrayFactoryWithInmemoryFileSystem({
    cwd = process.cwd,
    files = {}
} = {}) {

    /**
     * The in-memory file system for this mock.
     * @type {typeof import("fs")}
     */
    const fs = new MemoryFs({
        cwd,
        platform: process.platform === "win32" ? "win32" : "posix"
    });

    supportMkdirRecursiveOption(fs, cwd);
    fs.mkdirSync(cwd(), { recursive: true });

    /*
     * Stubs for proxyquire.
     * This contains the JavaScript files in `options.files`.
     */
    const stubs = {};

    stubs.fs = fs;
    stubs["import-fresh"] = fsImportFresh.bind(null, fs, stubs);
    stubs["./module-resolver"] = { resolve: fsResolve.bind(null, fs) };

    /*
     * Write all files to the in-memory file system and compile all JavaScript
     * files then set to `stubs`.
     */
    (function initFiles(directoryPath, definition) {
        for (const [filename, content] of Object.entries(definition)) {
            const filePath = path.resolve(directoryPath, filename);
            const parentPath = path.dirname(filePath);

            if (typeof content === "object") {
                initFiles(filePath, content);
                continue;
            }

            /*
             * Write this file to the in-memory file system.
             * For config files that `fs.readFileSync()` or `importFresh()` will
             * import.
             */
            if (!fs.existsSync(parentPath)) {
                fs.mkdirSync(parentPath, { recursive: true });
            }
            fs.writeFileSync(filePath, content);

            /*
             * Compile then stub if this file is a JavaScript file.
             * For parsers and plugins that `require()` will import.
             */
            if (path.extname(filePath) === ".js") {
                Object.defineProperty(stubs, filePath, {
                    configurable: true,
                    enumerable: true,
                    get() {
                        let stub;

                        try {
                            stub = compile(fs, stubs, filePath, content);
                        } catch (error) {
                            stub = { [ERRORED]: error };
                        }
                        Object.defineProperty(stubs, filePath, {
                            configurable: true,
                            enumerable: true,
                            writable: true,
                            value: stub
                        });

                        return stub;
                    }
                });
            }
        }
    }(cwd(), files));

    // Load the stubbed one.
    const { ConfigArrayFactory } = proxyquire(ConfigArrayFactoryPath, stubs);

    // Override the default cwd.
    return {
        fs,
        ConfigArrayFactory: cwd === process.cwd
            ? ConfigArrayFactory
            : class extends ConfigArrayFactory {
                constructor(options) {
                    super({ cwd: cwd(), ...options });
                }
            }
    };
}

/**
 * Define stubbed `FileEnumerator` class what uses the in-memory file system.
 * @param {Object} options The options.
 * @param {() => string} [options.cwd] The current working directory.
 * @param {Object} [options.files] The initial files definition in the in-memory file system.
 * @returns {{ fs: typeof import("fs"), FileEnumerator: (typeof import("../../../lib/lookup/file-enumerator"))["FileEnumerator"], ConfigArrayFactory: (typeof import("../../../lib/lookup/config-array-factory"))["ConfigArrayFactory"], IgnoredPaths: (typeof import("../../../lib/lookup/ignored-paths"))["IgnoredPaths"] }} The stubbed `FileEnumerator` class.
 */
function defineFileEnumeratorWithInmemoryFileSystem({
    cwd = process.cwd,
    files = {}
} = {}) {
    const { fs, ConfigArrayFactory } =
           defineConfigArrayFactoryWithInmemoryFileSystem({ cwd, files });
    const { IgnoredPaths } = proxyquire(IgnoredPathsPath, { fs });
    const loadRules = proxyquire(LoadRulesPath, { fs });
    const { FileEnumerator } = proxyquire(FileEnumeratorPath, {
        fs,
        "./config-array-factory": { ConfigArrayFactory },
        "./ignored-paths": { IgnoredPaths },
        "./load-rules": loadRules
    });

    // Override the default cwd.
    return {
        fs,
        ConfigArrayFactory,
        FileEnumerator: cwd === process.cwd
            ? FileEnumerator
            : class extends FileEnumerator {
                constructor(options) {
                    super({ cwd: cwd(), ...options });
                }
            },
        IgnoredPaths
    };
}

module.exports = {
    defineConfigArrayFactoryWithInmemoryFileSystem,
    defineFileEnumeratorWithInmemoryFileSystem
};
