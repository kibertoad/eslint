/**
 * @fileoverview `FileEnumerator` class.
 *
 * `FileEnumerator` class does three things in parallel:
 *
 * 1. Find target files.
 * 2. Find configuration files with handling cascading.
 * 3. Tie each target file and that configuration.
 *
 * It provies three methods:
 *
 * - `iterateFiles(patterns)`
 *     Iterate files which are matched by given patterns together with the
 *     corresponded configuration. This is for `CLIEngine#executeOnFiles()`.
 *     While iterating files, it loads the configuration file of each directory
 *     before iterate files on the directory, so we can use the configuration
 *     files to determine target files.
 * - `getConfigArrayForFile(filePath)`
 *     Get the corresponded configuration of a given file. This method doesn't
 *     throw even if the given file didn't exist. This is for `--print-config`
 *     and `CLIEngine#executeOnText()`.
 * - `clearCache()`
 *     Clear the internal cache.
 *
 * @example
 * const enumerator = new FileEnumerator();
 * const linter = new Linter();
 *
 * for (const { config, filePath } of enumerator.iterateFiles(["*.js"])) {
 *     const code = fs.readFileSync(filePath, "utf8");
 *     const messages = linter.verify(code, config, filePath);
 *
 *     console.log(messages);
 * }
 *
 * @author Toru Nagashima <https://github.com/mysticatea>
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");
const getGlobParent = require("glob-parent");
const isGlob = require("is-glob");
const { escapeRegExp } = require("lodash");
const { Minimatch } = require("minimatch");
const { validateConfigArray } = require("../config/config-validator");
const { ConfigArrayFactory } = require("./config-array-factory");
const { ConfigDependency } = require("./config-dependency");
const { IgnoredPaths } = require("./ignored-paths");
const loadRules = require("./load-rules");
const debug = require("debug")("eslint:file-enumerator");

// debug.enabled = true;

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const minimatchOpts = { dot: true, matchBase: true };
const dotfilesPattern = /(?:(?:^\.)|(?:[/\\]\.))[^/\\.].*/u;
const NONE = 0;
const IGNORED_SILENTLY = 1;
const IGNORED = 2;

// For VSCode intellisense
/** @typedef {ReturnType<ConfigArrayFactory["create"]>} ConfigArray */

/**
 * @typedef {Object} FileEnumeratorOptions
 * @property {ConfigData} [baseConfig] The config by `baseConfig` option.
 * @property {ConfigData} [cliConfig] The config by CLI options. This is prior to regular config files.
 * @property {ConfigArrayFactory} [configArrayFactory] The factory for config arrays.
 * @property {string} [cwd] The base directory to start lookup.
 * @property {string[]} [extensions] The extensions to match files for directory patterns.
 * @property {boolean} [globInputPaths] Set to false to skip glob resolution of input file paths to lint (default: true). If false, each input file paths is assumed to be a non-glob path to an existing file.
 * @property {boolean} [ignore] The flag to check ignored files.
 * @property {IgnoredPaths} [ignoredPaths] The ignored paths.
 * @property {string[]} [rulePaths] The value of `--rulesdir` option.
 * @property {string} [specificConfigPath] The value of `--config` option.
 * @property {boolean} [useEslintrc] if `false` then it doesn't load config files.
 */

/**
 * @typedef {Object} FileAndConfig
 * @property {string} filePath The path to a target file.
 * @property {ConfigArray} config The config entries of that file.
 * @property {boolean} ignored If `true` then this file should be ignored and warned because it was directly specified.
 */

/**
 * @typedef {Object} FileEntry
 * @property {string} filePath The path to a target file.
 * @property {ConfigArray} config The config entries of that file.
 * @property {NONE|IGNORED_SILENTLY|IGNORED} flag The flag.
 * - `NONE` means the file is a target file.
 * - `IGNORED_SILENTLY` means the file should be ignored silently.
 * - `IGNORED` means the file should be ignored and warned because it was directly specified.
 */

/**
 * @typedef {Object} FileEnumeratorInternalSlots
 * @property {ConfigArray} baseConfigArray The config array of `baseConfig` option.
 * @property {ConfigData} baseConfigData The config data of `baseConfig` option. This is used to reset `baseConfigArray`.
 * @property {ConfigArray} cliConfigArray The config array of CLI options.
 * @property {ConfigData} cliConfigData The config data of CLI options. This is used to reset `cliConfigArray`.
 * @property {ConfigArrayFactory} configArrayFactory The factory for config arrays.
 * @property {Map<string, ConfigArray>} configCache The cache from directory paths to config arrays.
 * @property {string} cwd The base directory to start lookup.
 * @property {RegExp} extRegExp The RegExp to test if a string ends with specific file extensions.
 * @property {WeakMap<ConfigArray, ConfigArray>} finalizeCache The cache from config arrays to finalized config arrays.
 * @property {boolean} globInputPaths Set to false to skip glob resolution of input file paths to lint (default: true). If false, each input file paths is assumed to be a non-glob path to an existing file.
 * @property {boolean} ignoreFlag The flag to check ignored files.
 * @property {IgnoredPaths} ignoredPathsWithDotfiles The ignored paths but don't include dot files.
 * @property {IgnoredPaths} ignoredPaths The ignored paths.
 * @property {string[]|null} rulePaths The value of `--rulesdir` option. This is used to reset `baseConfigArray`.
 * @property {string|null} specificConfigPath The value of `--config` option. This is used to reset `cliConfigArray`.
 * @property {boolean} useEslintrc if `false` then it doesn't load config files.
 */

/** @type {WeakMap<FileEnumerator, FileEnumeratorInternalSlots>} */
const internalSlotsMap = new WeakMap();

/**
 * Check if a string is a glob pattern or not.
 * @param {string} pattern A glob pattern.
 * @returns {boolean} `true` if the string is a glob pattern.
 */
function isGlobPattern(pattern) {
    return isGlob(path.sep === "\\" ? pattern.replace(/\\/gu, "/") : pattern);
}

/**
 * Get stats of a given path.
 * @param {string} filePath The path to target file.
 * @returns {fs.Stats|null} The stats.
 * @private
 */
function statSafeSync(filePath) {
    try {
        return fs.statSync(filePath);
    } catch (error) {
        /* istanbul ignore next */
        if (error.code !== "ENOENT") {
            throw error;
        }
        return null;
    }
}

/**
 * Get filenames in a given path to a directory.
 * @param {string} directoryPath The path to target directory.
 * @returns {string[]} The filenames.
 * @private
 */
function readdirSafeSync(directoryPath) {
    try {
        return fs.readdirSync(directoryPath);
    } catch (error) {
        /* istanbul ignore next */
        if (error.code !== "ENOENT") {
            throw error;
        }
        return [];
    }
}

/**
 * Create the config array from `baseConfig` and `rulePaths`.
 * @param {FileEnumeratorInternalSlots} slots The slots.
 * @returns {ConfigArray} The config array of the base configs.
 */
function createBaseConfigArray({
    configArrayFactory,
    baseConfigData,
    rulePaths,
    cwd
}) {
    const baseConfigArray = configArrayFactory.create(
        baseConfigData,
        { name: "BaseConfig" }
    );

    if (rulePaths && rulePaths.length > 0) {

        /*
         * Load rules `--rulesdir` option as a pseudo plugin.
         * Use a pseudo plugin to define rules of `--rulesdir`, so we can
         * validate the rule's options with only information in the config
         * array.
         */
        baseConfigArray.push({
            name: "--rulesdir",
            filePath: "",
            plugins: {
                "": new ConfigDependency({
                    definition: {
                        rules: rulePaths.reduce(
                            (map, rulesPath) => Object.assign(
                                map,
                                loadRules(rulesPath, cwd)
                            ),
                            {}
                        )
                    },
                    filePath: "",
                    id: "",
                    importerName: "--rulesdir",
                    importerPath: ""
                })
            }
        });
    }

    return baseConfigArray;
}

/**
 * Create the config array from CLI options.
 * @param {FileEnumeratorInternalSlots} slots The slots.
 * @returns {ConfigArray} The config array of the base configs.
 */
function createCLIConfigArray({
    cliConfigData,
    configArrayFactory,
    specificConfigPath
}) {
    const cliConfigArray = configArrayFactory.create(
        cliConfigData,
        { name: "CLIOptions" }
    );

    if (specificConfigPath) {
        cliConfigArray.unshift(
            ...configArrayFactory.loadFile(
                specificConfigPath,
                { name: "--config" }
            )
        );
    }

    return cliConfigArray;
}

/**
 * The error type when no files match a glob.
 */
class NoFilesFoundError extends Error {

    /**
     * @param {string} pattern - The glob pattern which was not found.
     * @param {boolean} globDisabled - If `true` then the pattern was a glob pattern, but glob was disabled.
     */
    constructor(pattern, globDisabled) {
        super(`No files matching '${pattern}' were found${globDisabled ? " (glob was disabled)" : ""}.`);
        this.messageTemplate = "file-not-found";
        this.messageData = { pattern, globDisabled };
    }
}

/**
 * The error type when there are files matched by a glob, but all of them have been ignored.
 */
class AllFilesIgnoredError extends Error {

    /**
     * @param {string} pattern - The glob pattern which was not found.
     */
    constructor(pattern) {
        super(`All files matched by '${pattern}' are ignored.`);
        this.messageTemplate = "all-files-ignored";
        this.messageData = { pattern };
    }
}

/**
 * The error type when there are files matched by a glob, but all of them have been ignored.
 */
class ConfigurationNotFoundError extends Error {

    /**
     * @param {string} directoryPath - The directory path.
     */
    constructor(directoryPath) {
        super(`No ESLint configuration found on ${directoryPath}.`);
        this.messageTemplate = "no-config-found";
        this.messageData = { directoryPath };
    }
}

/**
 * This class provides the functionality that enumerates every file which is
 * matched by given glob patterns and that configuration.
 */
class FileEnumerator {

    /**
     * Initialize this enumerator.
     * @param {FileEnumeratorOptions} options The options.
     */
    constructor({
        baseConfig: baseConfigData = null,
        cliConfig: cliConfigData = null,
        cwd = process.cwd(),
        configArrayFactory = new ConfigArrayFactory({ cwd }),
        extensions = [".js"],
        globInputPaths = true,
        ignore = true,
        ignoredPaths = new IgnoredPaths({ cwd, ignore }),
        rulePaths = [],
        specificConfigPath = null,
        useEslintrc = true
    } = {}) {
        internalSlotsMap.set(this, {
            baseConfigArray: createBaseConfigArray({
                baseConfigData,
                configArrayFactory,
                cwd,
                rulePaths
            }),
            baseConfigData,
            cliConfigArray: createCLIConfigArray({
                cliConfigData,
                configArrayFactory,
                specificConfigPath
            }),
            cliConfigData,
            configArrayFactory,
            configCache: new Map(),
            cwd,
            extRegExp: new RegExp(
                `.\\.(?:${extensions
                    .map(ext => escapeRegExp(
                        ext.startsWith(".")
                            ? ext.slice(1)
                            : ext
                    ))
                    .join("|")
                })$`,
                "u"
            ),
            finalizeCache: new WeakMap(),
            globInputPaths,
            ignoreFlag: ignore,
            ignoredPaths,
            ignoredPathsWithDotfiles: new IgnoredPaths({
                ...ignoredPaths.options,
                dotfiles: true
            }),
            rulePaths,
            specificConfigPath,
            useEslintrc
        });
    }

    /**
     * The current working directory that was specified by constructor.
     * @type {string}
     */
    get cwd() {
        return internalSlotsMap.get(this).cwd;
    }

    /**
     * The `RegExp` object that tests if a file path has the allowed file extensions.
     * @type {RegExp}
     */
    get extRegExp() {
        return internalSlotsMap.get(this).extRegExp;
    }

    /**
     * Get the config array of a given file.
     * @param {string} [filePath] The file path to a file.
     * @returns {ConfigArray} The config array of the file.
     */
    getConfigArrayForFile(filePath = "a.js") {
        const { cwd } = internalSlotsMap.get(this);
        const absolutePath = path.resolve(cwd, filePath);
        const config = this._loadConfigInAncestors(absolutePath);

        return this._finalizeConfigArray(config, path.dirname(absolutePath));
    }

    /**
     * Iterate files which are matched by given glob patterns.
     * @param {string|string[]} patternOrPatterns The glob patterns to iterate files.
     * @returns {IterableIterator<FileAndConfig>} The found files.
     */
    *iterateFiles(patternOrPatterns) {
        const { globInputPaths } = internalSlotsMap.get(this);
        const patterns = Array.isArray(patternOrPatterns)
            ? patternOrPatterns
            : [patternOrPatterns];

        debug("Start to iterate files: %o", patterns);

        // The set of paths to remove duplicate.
        const set = new Set();

        for (const pattern of patterns) {
            let foundRegardlessOfIgnored = false;
            let found = false;

            // Skip empty string.
            if (!pattern) {
                continue;
            }

            // Iterate files of this pttern.
            for (const { config, filePath, flag } of this._iterateFiles(pattern)) {
                foundRegardlessOfIgnored = true;
                if (flag === IGNORED_SILENTLY) {
                    continue;
                }
                found = true;

                // Remove duplicate paths while yielding paths.
                if (!set.has(filePath)) {
                    set.add(filePath);
                    yield {
                        config: this._finalizeConfigArray(
                            config,
                            path.dirname(filePath)
                        ),
                        filePath,
                        ignored: flag === IGNORED
                    };
                }
            }

            // Raise an error if any files were not found.
            if (!foundRegardlessOfIgnored) {
                throw new NoFilesFoundError(
                    pattern,
                    !globInputPaths && isGlob(pattern)
                );
            }
            if (!found) {
                throw new AllFilesIgnoredError(pattern);
            }
        }

        debug(`Complete iterating files: ${JSON.stringify(patterns)}`);
    }

    /**
     * Clear config cache.
     * @returns {void}
     */
    clearCache() {
        const slots = internalSlotsMap.get(this);

        slots.baseConfigArray = createBaseConfigArray(slots);
        slots.cliConfigArray = createCLIConfigArray(slots);
        slots.configCache.clear();
    }

    /**
     * Iterate files which are matched by a given glob pattern.
     * @param {string} pattern The glob pattern to iterate files.
     * @returns {IterableIterator<FileEntry>} The found files.
     */
    _iterateFiles(pattern) {
        const { cwd, globInputPaths } = internalSlotsMap.get(this);
        const absolutePath = path.resolve(cwd, pattern);

        if (globInputPaths && isGlobPattern(pattern)) {
            return this._iterateFilesWithGlob(
                absolutePath,
                dotfilesPattern.test(pattern)
            );
        }

        const stat = statSafeSync(absolutePath);

        if (stat && stat.isDirectory()) {
            return this._iterateFilesWithDirectory(
                absolutePath,
                dotfilesPattern.test(pattern)
            );
        }

        if (stat && stat.isFile()) {
            return this._iterateFilesWithFile(absolutePath);
        }

        return [];
    }

    /**
     * Iterate a file which is matched by a given path.
     * @param {string} filePath The path to the target file.
     * @returns {IterableIterator<FileEntry>} The found files.
     * @private
     */
    _iterateFilesWithFile(filePath) {
        debug(`File: ${filePath}`);

        const config = this._loadConfigInAncestors(filePath);
        const ignored = this._isIgnoredFile(filePath, { direct: true });
        const flag = ignored ? IGNORED : NONE;

        return [{ config, filePath, flag }];
    }

    /**
     * Iterate files in a given path.
     * @param {string} directoryPath The path to the target directory.
     * @param {boolean} dotfiles If `true` then it doesn't skip dot files by default.
     * @returns {IterableIterator<FileEntry>} The found files.
     * @private
     */
    _iterateFilesWithDirectory(directoryPath, dotfiles) {
        debug(`Directory: ${directoryPath}`);

        const config = this._loadConfigInAncestors(directoryPath);
        const options = { dotfiles, recursive: true, selector: null };

        return this._iterateFilesRecursive(directoryPath, config, options);
    }

    /**
     * Iterate files which are matched by a given glob pattern.
     * @param {string} pattern The glob pattern to iterate files.
     * @param {boolean} dotfiles If `true` then it doesn't skip dot files by default.
     * @returns {IterableIterator<FileEntry>} The found files.
     * @private
     */
    _iterateFilesWithGlob(pattern, dotfiles) {
        debug(`Glob: ${pattern}`);

        const directoryPath = getGlobParent(pattern);
        const globPart = pattern.slice(directoryPath.length + 1);
        const config = this._loadConfigInAncestors(directoryPath);

        /*
         * recursive if there are `**` or path separators in the glob part.
         * Otherwise, patterns such as `src/*.js`, it doesn't need recursive.
         */
        const recursive = /\*\*|\/|\\/u.test(globPart);
        const selector = new Minimatch(pattern, minimatchOpts);
        const options = { dotfiles, recursive, selector };

        debug(`recursive? ${recursive}`);

        return this._iterateFilesRecursive(directoryPath, config, options);
    }

    /**
     * Iterate files in a given path.
     * @param {string} directoryPath The path to the target directory.
     * @param {ConfigArray} parentConfig The config array of this context.
     * @param {Object} options The options to iterate files.
     * @param {boolean} [options.dotfiles] If `true` then it doesn't skip dot files by default.
     * @param {boolean} [options.recursive] If `true` then it dives into sub directories.
     * @param {Minimatch} [options.selector] The matcher to choose files.
     * @returns {IterableIterator<FileEntry>} The found files.
     * @private
     */
    *_iterateFilesRecursive(directoryPath, parentConfig, options) {
        if (this._isIgnoredFile(directoryPath, options)) {
            return;
        }
        debug(`Enter the directory: ${directoryPath}`);
        const { extRegExp } = internalSlotsMap.get(this);

        /*
         * Load a config file such as `.eslintrc` on this directory and merge
         * with the parent configuration.
         * If there are no config files here, `config === parentConfig`.
         */
        const config = this._loadConfigOnDirectory(
            directoryPath,
            parentConfig
        );

        // Enumerate the files of this directory.
        for (const filename of readdirSafeSync(directoryPath)) {
            const filePath = path.join(directoryPath, filename);
            const stat = statSafeSync(filePath); // TODO: Use `withFileTypes` in the future.

            // Check if the file is matched.
            if (stat && stat.isFile()) {
                const ignored = this._isIgnoredFile(filePath, options);
                const flag = ignored ? IGNORED_SILENTLY : NONE;
                const matched = options.selector

                    // Started with a glob pattern; choose by the pattern.
                    ? options.selector.match(filePath)

                    // Started with a directory path; choose by file extensions.
                    : extRegExp.test(filePath);

                if (matched) {
                    debug(`Yield: ${filename}${ignored ? " but ignored" : ""}`);
                    yield { config, filePath, flag };
                } else {
                    debug(`Didn't match: ${filename}`);
                }

            // Dive into the sub directory.
            } else if (options.recursive && stat && stat.isDirectory()) {
                yield* this._iterateFilesRecursive(filePath, config, options);
            }
        }

        debug(`Leave the directory: ${directoryPath}`);
    }

    /**
     * Check if a given file should be ignored.
     * @param {string} filePath The path to a file to check.
     * @param {Object} options Options
     * @param {boolean} [options.dotfiles] If `true` then this is not ignore dot files by default.
     * @param {boolean} [options.direct] If `true` then this is a direct specified file.
     * @returns {boolean} `true` if the file should be ignored.
     * @private
     */
    _isIgnoredFile(filePath, { dotfiles = false, direct = false }) {
        const {
            ignoreFlag,
            ignoredPaths,
            ignoredPathsWithDotfiles
        } = internalSlotsMap.get(this);
        const adoptedIgnoredPaths = dotfiles
            ? ignoredPathsWithDotfiles
            : ignoredPaths;

        return ignoreFlag
            ? adoptedIgnoredPaths.contains(filePath)
            : (!direct && adoptedIgnoredPaths.contains(filePath, "default"));
    }

    /**
     * Load and normalize config files from the ancestor directories.
     * @param {string} filePath The path to a file or a leaf directory.
     * @returns {ConfigArray} The loaded config.
     * @private
     */
    _loadConfigInAncestors(filePath) {
        debug(`Load config files from the ancestor directories of ${filePath}.`);
        return this._loadConfigInAncestorsRecursive(filePath);
    }

    /**
     * Load and normalize config files from the ancestor directories.
     * @param {string} filePath The path to a file or a leaf directory.
     * @returns {ConfigArray} The loaded config.
     * @private
     */
    _loadConfigInAncestorsRecursive(filePath) {
        const {
            baseConfigArray,
            configArrayFactory,
            configCache,
            cwd,
            useEslintrc
        } = internalSlotsMap.get(this);

        if (!useEslintrc) {
            return baseConfigArray;
        }

        const directoryPath = path.dirname(filePath);
        let configArray = configCache.get(directoryPath);

        // Hit cache.
        if (configArray) {
            debug(`Cache hit: ${directoryPath}.`);
            return configArray;
        }
        debug(`No cache found: ${directoryPath}.`);

        const homePath = os.homedir();

        // Consider this is root.
        if (
            !directoryPath ||
             directoryPath === filePath ||
             (directoryPath === homePath && cwd !== homePath)
        ) {
            debug("Stop traversing because of considered root.");
            configCache.set(directoryPath, baseConfigArray);
            return baseConfigArray;
        }

        // Load the config on this directory.
        try {
            configArray = configArrayFactory.loadOnDirectory(directoryPath);

            if (configArray.length > 0 && configArray.root) {
                debug("Stop traversing because of 'root:true'.");
                configCache.set(directoryPath, configArray);
                return configArray;
            }
        } catch (error) {
            /* istanbul ignore next */
            if (error.code === "EACCES") {
                debug("Stop traversing because of 'EACCES' error.");
                configCache.set(directoryPath, baseConfigArray);
                return baseConfigArray;
            }
            throw error;
        }

        // Load from the ancestors and merge it.
        if (configArray.length > 0) {
            configArray.unshift(
                ...this._loadConfigInAncestorsRecursive(directoryPath)
            );
        } else {
            configArray = this._loadConfigInAncestorsRecursive(directoryPath);
        }

        configCache.set(directoryPath, configArray);
        return configArray;
    }

    /**
     * Load and normalize config files from a given directory.
     * @param {string} directoryPath The path to the directory to load.
     * @param {ConfigArray} parentConfigArray The parent config array.
     * @returns {ConfigArray} The loaded config.
     * @private
     */
    _loadConfigOnDirectory(directoryPath, parentConfigArray) {
        const { configArrayFactory, useEslintrc } = internalSlotsMap.get(this);

        if (!useEslintrc) {
            return parentConfigArray;
        }

        return configArrayFactory.loadOnDirectory(
            directoryPath,
            { parent: parentConfigArray }
        );
    }

    /**
     * Finalize a given config array.
     * Concatinate `--config` and other CLI options.
     * @param {ConfigArray} configArray The parent config array.
     * @param {string} directoryPath The path to the leaf directory to find config files.
     * @returns {ConfigArray} The loaded config.
     * @private
     */
    _finalizeConfigArray(configArray, directoryPath) {
        const {
            cliConfigArray,
            configArrayFactory,
            finalizeCache,
            useEslintrc
        } = internalSlotsMap.get(this);

        let finalConfigArray = finalizeCache.get(configArray);

        if (!finalConfigArray) {
            finalConfigArray = configArray;

            // Load the personal config if there are no regular config files.
            if (
                useEslintrc &&
                configArray.every(c => !c.filePath) &&
                cliConfigArray.every(c => !c.filePath) // `--config` option can be a file.
            ) {
                debug("Loading the config file of the home directory.");

                finalConfigArray = configArrayFactory.loadOnDirectory(
                    os.homedir(),
                    { name: "PersonalConfig", parent: finalConfigArray }
                );
            }

            // Apply CLI options.
            if (cliConfigArray.length > 0) {
                finalConfigArray = finalConfigArray.concat(cliConfigArray);
            }

            // Validate rule settings and environments.
            validateConfigArray(finalConfigArray);

            // Cache it.
            finalizeCache.set(configArray, finalConfigArray);

            debug(
                "Configuration was determined: %o on %s",
                finalConfigArray,
                directoryPath
            );
        }

        if (useEslintrc && finalConfigArray.length === 0) {
            throw new ConfigurationNotFoundError(directoryPath);
        }

        return finalConfigArray;
    }
}

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

module.exports = { FileEnumerator };
