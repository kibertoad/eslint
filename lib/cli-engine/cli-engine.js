/**
 * @fileoverview newly CLIEngine.
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const DefaultOptions = require("../../conf/default-cli-options");
const { version } = require("../../package.json");
const ConfigOps = require("../config/config-ops");
const { Linter, getLinterInternalSlots } = require("../linter");
const {
    ConfigArrayFactory,
    FileEnumerator,
    IgnoredPaths,
    loadFormatter
} = require("../lookup");
const { getUsedExtractedConfigs } = require("../lookup/config-array");
const hash = require("./hash");
const LintResultCache = require("./lint-result-cache");
const debug = require("debug")("eslint:cli-engine");

/**
 * The options to configure a CLI engine with.
 * @typedef {Object} CLIEngineOptions
 * @property {boolean} allowInlineConfig Enable or disable inline configuration comments.
 * @property {Object} baseConfig Base config object, extended by all configs used with this CLIEngine instance
 * @property {boolean} cache Enable result caching.
 * @property {string} cacheLocation The cache file to use instead of .eslintcache.
 * @property {string} configFile The configuration file to use.
 * @property {string} cwd The value to use for the current working directory.
 * @property {string[]} envs An array of environments to load.
 * @property {string[]} extensions An array of file extensions to check.
 * @property {boolean|Function} fix Execute in autofix mode. If a function, should return a boolean.
 * @property {string[]} fixTypes Array of rule types to apply fixes for.
 * @property {string[]} globals An array of global variables to declare.
 * @property {boolean} ignore False disables use of .eslintignore.
 * @property {string} ignorePath The ignore file to use instead of .eslintignore.
 * @property {string} ignorePattern A glob pattern of files to ignore.
 * @property {boolean} useEslintrc False disables looking for .eslintrc
 * @property {string} parser The name of the parser to use.
 * @property {Object} parserOptions An object of parserOption settings to use.
 * @property {string[]} plugins An array of plugins to load.
 * @property {Object<string,*>} rules An object of rules to use.
 * @property {string[]} rulePaths An array of directories to load custom rules from.
 * @property {boolean} reportUnusedDisableDirectives `true` adds reports for unused eslint-disable directives
 * @property {boolean} globInputPaths Set to false to skip glob resolution of input file paths to lint (default: true). If false, each input file paths is assumed to be a non-glob path to an existing file.
 */

/**
 * A linting warning or error.
 * @typedef {Object} LintMessage
 * @property {string} message The message to display to the user.
 */

/**
 * A linting result.
 * @typedef {Object} LintResult
 * @property {string} filePath The path to the file that was linted.
 * @property {LintMessage[]} messages All of the messages for the result.
 * @property {number} errorCount Number of errors for the result.
 * @property {number} warningCount Number of warnings for the result.
 * @property {number} fixableErrorCount Number of fixable errors for the result.
 * @property {number} fixableWarningCount Number of fixable warnings for the result.
 * @property {string=} [source] The source code of the file that was linted.
 * @property {string=} [output] The source code of the file that was linted, with as many fixes applied as possible.
 */

/**
 * Private data for CLIEngine.
 * @typedef {Object} CLIEngineInternalSlots
 * @property {Map<string, Object>} additionalPluginPool The map for additional plugins.
 * @property {string} cacheFilePath The path to the cache of lint results.
 * @property {FileEnumerator} fileEnumerator The file enumerator.
 * @property {IgnoredPaths} ignoredPaths The ignored paths.
 * @property {LintResultCache|null} lintResultCache The cache of lint results.
 * @property {Linter} linter The linter instance which has loaded rules.
 * @property {CLIEngineOptions} options The normalized options of this instance.
 */

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const validFixTypes = new Set(["problem", "suggestion", "layout"]);

/** @type {WeakMap<CLIEngine, CLIEngineInternalSlots>} */
const internalSlotsMap = new WeakMap();

/**
 * Determines if each fix type in an array is supported by ESLint and throws
 * an error if not.
 * @param {string[]} fixTypes An array of fix types to check.
 * @returns {void}
 * @throws {Error} If an invalid fix type is found.
 */
function validateFixTypes(fixTypes) {
    for (const fixType of fixTypes) {
        if (!validFixTypes.has(fixType)) {
            throw new Error(`Invalid fix type "${fixType}" found.`);
        }
    }
}

/**
 * Convert a string array to a boolean map.
 * @param {string[]|null} keys The keys to assign true.
 * @param {boolean} defaultValue The default value for each property.
 * @param {string} displayName The property name which is used in error message.
 * @returns {Record<string,boolean>} The boolean map.
 */
function toBooleanMap(keys, defaultValue, displayName) {
    if (keys && !Array.isArray(keys)) {
        throw new Error(`${displayName} must be an array.`);
    }
    if (keys && keys.length > 0) {
        return keys.reduce((map, def) => {
            const [key, value] = def.split(":");

            if (key !== "__proto__") {
                map[key] = value === void 0
                    ? defaultValue
                    : value === "true";
            }

            return map;
        }, {});
    }
    return void 0;
}

/**
 * Create a config data from CLI options.
 * @param {CLIEngineOptions} options The options
 * @returns {ConfigData|null} The created config data.
 */
function createConfigDataFromOptions(options) {
    const { parser, parserOptions, plugins, rules } = options;
    const env = toBooleanMap(options.envs, true, "envs");
    const globals = toBooleanMap(options.globals, false, "globals");

    if (
        env === void 0 &&
        globals === void 0 &&
        parser === void 0 &&
        parserOptions === void 0 &&
        plugins === void 0 &&
        rules === void 0
    ) {
        return null;
    }
    return { env, globals, parser, parserOptions, plugins, rules };
}

/**
 * return the cacheFile to be used by eslint, based on whether the provided parameter is
 * a directory or looks like a directory (ends in `path.sep`), in which case the file
 * name will be the `cacheFile/.cache_hashOfCWD`
 *
 * if cacheFile points to a file or looks like a file then in will just use that file
 *
 * @param {string} cacheFile The name of file to be used to store the cache
 * @param {string} cwd Current working directory
 * @returns {string} the resolved path to the cache file
 */
function normalizeCacheFilePath(cacheFile, cwd) {

    /*
     * make sure the path separators are normalized for the environment/os
     * keeping the trailing path separator if present
     */
    const normalizedCacheFile = path.normalize(cacheFile);

    const resolvedCacheFile = path.resolve(cwd, normalizedCacheFile);
    const looksLikeADirectory = normalizedCacheFile.slice(-1) === path.sep;

    /**
     * return the name for the cache file in case the provided parameter is a directory
     * @returns {string} the resolved path to the cacheFile
     */
    function getCacheFileForDirectory() {
        return path.join(resolvedCacheFile, `.cache_${hash(cwd)}`);
    }

    let fileStats;

    try {
        fileStats = fs.lstatSync(resolvedCacheFile);
    } catch (ex) {
        fileStats = null;
    }


    /*
     * in case the file exists we need to verify if the provided path
     * is a directory or a file. If it is a directory we want to create a file
     * inside that directory
     */
    if (fileStats) {

        /*
         * is a directory or is a file, but the original file the user provided
         * looks like a directory but `path.resolve` removed the `last path.sep`
         * so we need to still treat this like a directory
         */
        if (fileStats.isDirectory() || looksLikeADirectory) {
            return getCacheFileForDirectory();
        }

        // is file so just use that file
        return resolvedCacheFile;
    }

    /*
     * here we known the file or directory doesn't exist,
     * so we will try to infer if its a directory if it looks like a directory
     * for the current operating system.
     */

    // if the last character passed is a path separator we assume is a directory
    if (looksLikeADirectory) {
        return getCacheFileForDirectory();
    }

    return resolvedCacheFile;
}

/**
 * It will calculate the error and warning count for collection of messages per file
 * @param {Object[]} messages - Collection of messages
 * @returns {Object} Contains the stats
 * @private
 */
function calculateStatsPerFile(messages) {
    return messages.reduce(
        (stat, message) => {
            if (message.fatal || message.severity === 2) {
                stat.errorCount++;
                if (message.fix) {
                    stat.fixableErrorCount++;
                }
            } else {
                stat.warningCount++;
                if (message.fix) {
                    stat.fixableWarningCount++;
                }
            }
            return stat;
        },
        {
            errorCount: 0,
            warningCount: 0,
            fixableErrorCount: 0,
            fixableWarningCount: 0
        }
    );
}

/**
 * It will calculate the error and warning count for collection of results from all files
 * @param {Object[]} results - Collection of messages from all the files
 * @returns {Object} Contains the stats
 * @private
 */
function calculateStatsPerRun(results) {
    return results.reduce(
        (stat, result) => {
            stat.errorCount += result.errorCount;
            stat.warningCount += result.warningCount;
            stat.fixableErrorCount += result.fixableErrorCount;
            stat.fixableWarningCount += result.fixableWarningCount;
            return stat;
        },
        {
            errorCount: 0,
            warningCount: 0,
            fixableErrorCount: 0,
            fixableWarningCount: 0
        }
    );
}

/**
 * Collect used deprecated rules.
 * @param {ConfigArray[]} usedConfigArrays The config arrays which were used.
 * @param {Map<string, Object>} ruleMap The rule definitions which were used (built-ins).
 * @returns {IterableIterator<Object>} Used deprecated rules.
 */
function *iterateRuleDeprecationWarnings(usedConfigArrays, ruleMap) {
    const processedRuleIds = new Set();

    /**
     * Get a rule.
     * @param {string} ruleId The rule ID to get.
     * @returns {Object|null} The rule or null.
     */
    function getRule(ruleId) {
        for (const configArray of usedConfigArrays) {
            const rule = configArray.pluginRules.get(ruleId);

            if (rule) {
                return rule;
            }
        }
        return ruleMap.get(ruleId) || null;
    }

    // Flatten used configs.
    const configs = [].concat(
        ...usedConfigArrays.map(getUsedExtractedConfigs)
    );

    // Traverse rule configs.
    for (const config of configs) {
        for (const [ruleId, ruleConfig] of Object.entries(config.rules)) {

            // Skip if it was processed.
            if (processedRuleIds.has(ruleId)) {
                continue;
            }
            processedRuleIds.add(ruleId);

            // Skip if it's not used.
            if (!ConfigOps.getRuleSeverity(ruleConfig)) {
                continue;
            }
            const rule = getRule(ruleId);

            // Skip if it's not deprecated.
            if (!(rule && rule.meta && rule.meta.deprecated)) {
                continue;
            }

            // This rule was used and deprecated.
            yield {
                ruleId,
                replacedBy: rule.meta.replacedBy || []
            };
        }
    }
}

/**
 * Returns result with warning by ignore settings
 * @param {string} filePath - File path of checked code
 * @param {string} baseDir  - Absolute path of base directory
 * @returns {LintResult} Result with single warning
 * @private
 */
function createIgnoreResult(filePath, baseDir) {
    let message;
    const isHidden = /^\./u.test(path.basename(filePath));
    const isInNodeModules = baseDir && path.relative(baseDir, filePath).startsWith("node_modules");
    const isInBowerComponents = baseDir && path.relative(baseDir, filePath).startsWith("bower_components");

    if (isHidden) {
        message = "File ignored by default.  Use a negated ignore pattern (like \"--ignore-pattern '!<relative/path/to/filename>'\") to override.";
    } else if (isInNodeModules) {
        message = "File ignored by default. Use \"--ignore-pattern '!node_modules/*'\" to override.";
    } else if (isInBowerComponents) {
        message = "File ignored by default. Use \"--ignore-pattern '!bower_components/*'\" to override.";
    } else {
        message = "File ignored because of a matching ignore pattern. Use \"--no-ignore\" to override.";
    }

    return {
        filePath: path.resolve(filePath),
        messages: [
            {
                fatal: false,
                severity: 1,
                message
            }
        ],
        errorCount: 0,
        warningCount: 1,
        fixableErrorCount: 0,
        fixableWarningCount: 0
    };
}

/**
 * Verify
 * @param {string} text The source code to verify.
 * @param {string} filePath The path to the file of `text`.
 * @param {ConfigArray} config The config.
 * @param {RegExp} extRegExp The `RegExp` object that tests if a file path has the allowed file extensions.
 * @param {boolean} fix If `true` then it does fix.
 * @param {boolean} allowInlineConfig If `true` then it uses directive comments.
 * @param {boolean} reportUnusedDisableDirectives If `true` then it reports unused `eslint-disable` comments.
 * @param {Linter} linter The linter instance to verify.
 * @returns {IterableIterator<LintMessage>} Messages.
 */
function verifyText(
    text,
    filePath,
    config,
    extRegExp,
    fix,
    allowInlineConfig,
    reportUnusedDisableDirectives,
    linter
) {
    debug(`Lint ${filePath}`);

    // Verify.
    const { fixed, messages, output } = linter.verifyAndFix(
        text,
        config,
        {
            allowInlineConfig,
            extRegExp,
            filename: filePath,
            fix,
            reportUnusedDisableDirectives
        }
    );

    const basename = path.basename(filePath, path.extname(filePath));
    const resultFilePath = basename.startsWith("<") && basename.endsWith(">")
        ? basename
        : filePath;

    // Tweak and return.
    const result = {
        filePath: resultFilePath,
        messages,
        ...calculateStatsPerFile(messages)
    };

    if (fixed) {
        result.output = output;
    }
    if (
        result.errorCount + result.warningCount > 0 &&
        typeof result.output === "undefined"
    ) {
        result.source = text;
    }

    return result;
}

/**
 * Checks whether a directory exists at the given location
 * @param {string} resolvedPath A path from the CWD
 * @returns {boolean} `true` if a directory exists
 */
function directoryExists(resolvedPath) {
    try {
        return fs.statSync(resolvedPath).isDirectory();
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

/**
 * CLIEngine.
 */
class CLIEngine {

    /**
     * The version string.
     * @type {string}
     */
    static get version() {
        return version;
    }

    /**
     * Returns results that only contains errors.
     * @param {LintResult[]} results The results to filter.
     * @returns {LintResult[]} The filtered results.
     */
    static getErrorResults(results) {
        const filtered = [];

        results.forEach(result => {
            const filteredMessages =
                result.messages.filter(m => m.severity === 2);

            if (filteredMessages.length > 0) {
                filtered.push(
                    Object.assign(result, {
                        messages: filteredMessages,
                        errorCount: filteredMessages.length,
                        warningCount: 0,
                        fixableErrorCount: result.fixableErrorCount,
                        fixableWarningCount: 0
                    })
                );
            }
        });

        return filtered;
    }

    /**
     * Returns the formatter representing the given format or null if no formatter
     * with the given name can be found.
     * @param {string} [format] The name of the format to load or the path to a
     *      custom formatter.
     * @returns {Function} The formatter function or null if not found.
     */
    static getFormatter(format) {
        return loadFormatter(format || "stylish", process.cwd());
    }

    /**
     * Outputs fixes from the given results to files.
     * @param {Object} report The report object created by CLIEngine.
     * @returns {void}
     */
    static outputFixes(report) {
        report.results.filter(result => Object.prototype.hasOwnProperty.call(result, "output")).forEach(result => {
            fs.writeFileSync(result.filePath, result.output);
        });
    }

    /**
     * Creates a new instance of the core CLI engine.
     * @param {CLIEngineOptions} providedOptions The options for this instance.
     */
    constructor(providedOptions) {
        const options = Object.assign(
            Object.create(null),
            DefaultOptions,
            { cwd: process.cwd() },
            providedOptions
        );

        if (options.fix === void 0) {
            options.fix = false;
        }

        const additionalPluginPool = new Map();
        const cacheFilePath = normalizeCacheFilePath(
            options.cacheLocation || options.cacheFile,
            options.cwd
        );
        const ignoredPaths = new IgnoredPaths(options);
        const fileEnumerator = new FileEnumerator({
            baseConfig: options.baseConfig || null,
            cliConfig: createConfigDataFromOptions(options),
            configArrayFactory: new ConfigArrayFactory({
                additionalPluginPool,
                cwd: options.cwd
            }),
            cwd: options.cwd,
            extensions: options.extensions,
            globInputPaths: options.globInputPaths,
            ignore: options.ignore,
            ignoredPaths,
            rulePaths: options.rulePaths,
            specificConfigPath: options.configFile,
            useEslintrc: options.useEslintrc
        });
        const lintResultCache =
            options.cache ? new LintResultCache(cacheFilePath) : null;
        const linter = new Linter();

        // Store private data.
        internalSlotsMap.set(this, {
            additionalPluginPool,
            cacheFilePath,
            fileEnumerator,
            ignoredPaths,
            lintResultCache,
            linter,
            options
        });

        // setup special filter for fixes
        if (options.fix && options.fixTypes && options.fixTypes.length > 0) {
            debug(`Using fix types ${options.fixTypes}`);

            // throw an error if any invalid fix types are found
            validateFixTypes(options.fixTypes);

            // convert to Set for faster lookup
            const fixTypes = new Set(options.fixTypes);

            // save original value of options.fix in case it's a function
            const originalFix = (typeof options.fix === "function")
                ? options.fix
                : () => options.fix;

            options.fix = message => {

                // avoid `linter.getRules()` for performance.
                const { lastConfigArray, ruleMap } = getLinterInternalSlots(linter);
                const rule = (
                    (lastConfigArray && lastConfigArray.pluginRules.get(message.ruleId)) ||
                    ruleMap.get(message.ruleId)
                );
                const matches = rule.meta && fixTypes.has(rule.meta.type);

                return matches && originalFix(message);
            };
        }
    }

    /**
     * Executes the current configuration on an array of file and directory names.
     * @param {string[]} patterns An array of file and directory names.
     * @returns {Object} The results for all files that were linted.
     */
    executeOnFiles(patterns) {
        const slots = internalSlotsMap.get(this);
        const {
            cacheFilePath,
            fileEnumerator,
            linter,
            options: {
                allowInlineConfig,
                cache,
                cwd,
                fix,
                reportUnusedDisableDirectives
            },
            lintResultCache
        } = slots;
        const usedConfigs = new Set();
        const results = [];
        const startTime = Date.now();

        // Delete cache file; should this do here?
        if (!cache) {
            try {
                fs.unlinkSync(cacheFilePath);
            } catch (error) {
                if (!error || error.code !== "ENOENT") {
                    throw error;
                }
            }
        }

        // Iterate source code files.
        for (const { config, filePath, ignored } of fileEnumerator.iterateFiles(patterns)) {
            if (ignored) {
                results.push(createIgnoreResult(filePath, cwd));
                continue;
            }

            // Skip if there is cached result.
            if (lintResultCache) {
                const cachedResult =
                    lintResultCache.getCachedLintResults(filePath, config);

                if (cachedResult) {
                    const hadMessages =
                        cachedResult.messages &&
                        cachedResult.messages.length > 0;

                    if (hadMessages && fix) {
                        debug(`Reprocessing cached file to allow autofix: ${filePath}`);
                    } else {
                        debug(`Skipping file since it hasn't changed: ${filePath}`);
                        results.push(cachedResult);
                        continue;
                    }
                }
            }

            // Store used configs to collect used deprecated rules later.
            usedConfigs.add(config);

            // Do lint.
            const result = verifyText(
                fs.readFileSync(filePath, "utf8"),
                filePath,
                config,
                fileEnumerator.extRegExp,
                fix,
                allowInlineConfig,
                reportUnusedDisableDirectives,
                linter
            );

            results.push(result);

            // Store the result.
            if (lintResultCache) {
                lintResultCache.setCachedLintResults(filePath, config, result);
            }
        }

        // Persist the cache to disk.
        if (lintResultCache) {
            lintResultCache.reconcile();
        }

        // Collect used deprecated rules.
        const usedDeprecatedRules = Array.from(
            iterateRuleDeprecationWarnings(
                Array.from(usedConfigs),
                getLinterInternalSlots(linter).ruleMap // avoid `linter.getRules()` for performance.
            )
        );

        debug(`Linting complete in: ${Date.now() - startTime}ms`);
        return {
            results,
            ...calculateStatsPerRun(results),
            usedDeprecatedRules
        };
    }

    /**
     * Executes the current configuration on text.
     * @param {string} text A string of JavaScript code to lint.
     * @param {string} filename An optional string representing the texts filename.
     * @param {boolean} warnIgnored Always warn when a file is ignored
     * @returns {Object} The results for the linting.
     */
    executeOnText(text, filename, warnIgnored) {
        const slots = internalSlotsMap.get(this);
        const {
            fileEnumerator,
            ignoredPaths,
            linter,
            options: {
                allowInlineConfig,
                cwd,
                fix,
                reportUnusedDisableDirectives
            }
        } = slots;
        const results = [];
        const startTime = Date.now();
        const resolvedFilename = path.resolve(cwd, filename || "<text>.js");
        const usedDeprecatedRules = [];

        if (filename && ignoredPaths.contains(resolvedFilename)) {
            if (warnIgnored) {
                results.push(createIgnoreResult(resolvedFilename, cwd));
            }
        } else {
            const config = fileEnumerator.getConfigArrayForFile(resolvedFilename);

            // Do lint.
            results.push(verifyText(
                text,
                resolvedFilename,
                config,
                fileEnumerator.extRegExp,
                fix,
                allowInlineConfig,
                reportUnusedDisableDirectives,
                linter
            ));

            // Collect used deprecated rules.
            usedDeprecatedRules.push(
                ...iterateRuleDeprecationWarnings(
                    [config],
                    getLinterInternalSlots(linter).ruleMap // avoid `linter.getRules()` for performance.
                )
            );
        }

        debug(`Linting complete in: ${Date.now() - startTime}ms`);
        return {
            results,
            ...calculateStatsPerRun(results),
            usedDeprecatedRules
        };
    }

    /**
     * Get rules.
     * @returns {Map<string, Rule>} The rule map.
     */
    getRules() {
        const { linter } = internalSlotsMap.get(this);

        return linter.getRules();
    }

    /**
     * Returns the formatter representing the given format or null if no formatter
     * with the given name can be found.
     * @param {string} [format] The name of the format to load or the path to a
     *      custom formatter.
     * @returns {Function} The formatter function or null if not found.
     */
    getFormatter(format) {
        const { options } = internalSlotsMap.get(this);

        return loadFormatter(format || "stylish", options.cwd);
    }

    /**
     * Returns a configuration object for the given file based on the CLI options.
     * This is the same logic used by the ESLint CLI executable to determine
     * configuration for each file it processes.
     * @param {string} filePath The path of the file to retrieve a config object for.
     * @returns {Object} A configuration object for the file.
     */
    getConfigForFile(filePath = "a.js") {
        const { fileEnumerator, options } = internalSlotsMap.get(this);
        const absolutePath = path.resolve(options.cwd, filePath);

        return fileEnumerator
            .getConfigArrayForFile(absolutePath)
            .extractConfig(absolutePath)
            .toCompatibleObjectAsConfigFileContent();
    }

    /**
     * Checks if a given path is ignored by ESLint.
     * @param {string} filePath The path of the file to check.
     * @returns {boolean} Whether or not the given path is ignored.
     */
    isPathIgnored(filePath) {
        const { ignoredPaths } = internalSlotsMap.get(this);

        return ignoredPaths.contains(filePath);
    }

    /**
     * Add a plugin by passing its configuration
     * @param {string} name Name of the plugin.
     * @param {Object} pluginObject Plugin configuration object.
     * @returns {void}
     */
    addPlugin(name, pluginObject) {
        const {
            additionalPluginPool,
            fileEnumerator
        } = internalSlotsMap.get(this);

        additionalPluginPool.set(name, pluginObject);
        fileEnumerator.clearCache();
    }

    /**
     * This logic is no longer used, but remaining for backward compatibility.
     * @param {string[]} patterns The file patterns passed on the command line.
     * @returns {string[]} The equivalent glob patterns.
     */
    resolveFileGlobPatterns(patterns) {
        const { options } = internalSlotsMap.get(this);

        if (options.globInputPaths === false) {
            return patterns.filter(Boolean);
        }

        const extensions = options.extensions.map(ext => ext.replace(/^\./u, ""));
        const dirSuffix = extensions.length === 1
            ? `/**/*.${extensions[0]}`
            : `/**/*.{${extensions.join(",")}}`;

        return patterns.filter(Boolean).map(pathname => {
            const resolvedPath = path.resolve(options.cwd, pathname);
            const newPath = directoryExists(resolvedPath)
                ? pathname.replace(/[/\\]$/u, "") + dirSuffix
                : pathname;

            return path.normalize(newPath).replace(/\\/gu, "/");
        });
    }
}

module.exports = {
    CLIEngine,

    /**
     * Get the internal slots of a given CLIEngine instance for tests.
     * @param {CLIEngine} instance The CLIEngine instance to get.
     * @returns {CLIEngineInternalSlots} The internal slots.
     */
    getCLIEngineInternalSlots(instance) {
        return internalSlotsMap.get(instance);
    }
};
